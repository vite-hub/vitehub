import { useDatabase } from "@vite-hub/database"
import { is } from "drizzle-orm"
import { PgAsyncDatabase } from "drizzle-orm/pg-core/async/db"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { POSTGRES_STATE_DATABASE_NOW as DB_NOW } from "../internal/state-database-clock.ts"
import { agentInvocationPostgresClient } from "../invocations/postgres-clients.ts"
import { ViteHubSqliteAgentStateAdapter } from "./sqlite.ts"

import type { AgentInvocationPostgresClient, AgentInvocationPostgresQuery } from "../invocations/postgres-store.ts"
import type { AgentStateSqlDialect, AgentStateTables, SqliteAgentStateDriver, SqliteAgentStateExecutor, SqliteAgentStateOptions, SqliteAgentStateRow } from "./sqlite.ts"

type PostgresValue = NonNullable<Parameters<AgentInvocationPostgresQuery["unsafe"]>[1]>[number]

const MAX_TIME = Number.MAX_SAFE_INTEGER
const MAX_TABLE_PREFIX_LENGTH = 63 - "idx_webhook_queue_active_scope".length

export interface PostgresAgentStateOptions extends Omit<SqliteAgentStateOptions, "driver" | "durable"> {
  /** A postgres.js client, a node-postgres Pool, or PGlite. */
  client: unknown
  /** The name of the Database in diagnostics. */
  database?: string
  /** Defaults to `true`. Set `false` for an in-memory PGlite. */
  durable?: boolean
}

export interface DatabaseAgentStateOptions extends Omit<PostgresAgentStateOptions, "client" | "database"> {
  /** The ViteHub Database. Defaults to `default`. It must run on Postgres. */
  database?: string
}

function postgresValue(value: unknown): PostgresValue {
  if (value === undefined || value === null) return null
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint") return String(value)
  throw agentDiagnostics.AGENT_STATE_POSTGRES_VALUE_UNSUPPORTED({ type: value instanceof Object ? value.constructor.name : typeof value })
}

function executor(sql: AgentInvocationPostgresQuery): SqliteAgentStateExecutor {
  return { execute: async (statement, args = []) => [...await sql.unsafe(statement, args.map(postgresValue))] }
}

async function rows(tx: SqliteAgentStateExecutor, statement: string): Promise<SqliteAgentStateRow[]> {
  const result = await tx.execute(statement)
  return Array.isArray(result) ? result : result?.rows ?? []
}

async function migratePostgresTables({ tables, transaction }: Parameters<AgentStateSqlDialect["migrate"]>[0]): Promise<void> {
  await transaction(async (tx) => {
    const [relation] = await rows(tx, `SELECT to_regclass('${tables.schemaVersion}') IS NOT NULL AS present`)
    if (!relation?.present) await rows(tx, `CREATE TABLE IF NOT EXISTS ${tables.schemaVersion} (version INTEGER PRIMARY KEY)`)
    const [current] = await rows(tx, `SELECT COALESCE(MAX(version), 0) AS version FROM ${tables.schemaVersion}`)
    if (Number(current?.version ?? 0) >= 5) return
    for (const statement of postgresSchema(tables)) await rows(tx, statement)
    await rows(tx, `INSERT INTO ${tables.schemaVersion} (version) VALUES (5) ON CONFLICT DO NOTHING`)
  })
}

function postgresSchema(tables: AgentStateTables): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${tables.subscriptions} (thread_id TEXT PRIMARY KEY)`,
    `CREATE TABLE IF NOT EXISTS ${tables.locks} (thread_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${tables.cache} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS idx_${tables.locks}_expires ON ${tables.locks}(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_${tables.cache}_expires ON ${tables.cache}(expires_at) WHERE expires_at IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${tables.queue} (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, thread_id TEXT NOT NULL, value TEXT NOT NULL, enqueued_at BIGINT NOT NULL, expires_at BIGINT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_${tables.queue}_thread ON ${tables.queue}(thread_id, id)`,
    `CREATE INDEX IF NOT EXISTS idx_${tables.queue}_expires ON ${tables.queue}(expires_at)`,
    `CREATE TABLE IF NOT EXISTS ${tables.lists} (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, key TEXT NOT NULL, value TEXT NOT NULL, expires_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS idx_${tables.lists}_key ON ${tables.lists}(key, id)`,
    `CREATE INDEX IF NOT EXISTS idx_${tables.lists}_expires ON ${tables.lists}(expires_at) WHERE expires_at IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${tables.webhookQueue} (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      scope TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      value TEXT NOT NULL,
      concurrency_group TEXT NOT NULL,
      concurrency_key TEXT,
      concurrency_limit BIGINT NOT NULL,
      lease_ttl_ms BIGINT NOT NULL,
      status TEXT NOT NULL,
      enqueued_at BIGINT NOT NULL,
      available_at BIGINT NOT NULL,
      attempts BIGINT NOT NULL DEFAULT 0,
      lease_token TEXT,
      lease_expires_at BIGINT,
      UNIQUE (scope, delivery_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${tables.webhookQueue}_claim ON ${tables.webhookQueue}(scope, status, available_at, id)`,
    `CREATE INDEX IF NOT EXISTS idx_${tables.webhookQueue}_group ON ${tables.webhookQueue}(concurrency_group, status, lease_expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_${tables.webhookQueue}_key ON ${tables.webhookQueue}(concurrency_key, status, lease_expires_at) WHERE concurrency_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_${tables.webhookQueue}_active_scope ON ${tables.webhookQueue}(scope) WHERE status != 'completed'`,
  ]
}

function decodeWebhookPayload(value: string): string {
  const decoded: unknown = JSON.parse(value)
  if (typeof decoded !== "object" || decoded === null || !("payload" in decoded) || typeof decoded.payload !== "string") {
    throw new TypeError("Invalid Postgres Agent State webhook payload.")
  }
  return decoded.payload
}

function decodeWebhookKey(value: string): string {
  const decoded: unknown = JSON.parse(value)
  if (typeof decoded !== "string") throw new TypeError("Invalid Postgres Agent State webhook key.")
  return decoded
}

const postgresAgentStateDialect: AgentStateSqlDialect = {
  name: "postgresql",
  now: DB_NOW,
  time: `LEAST(${DB_NOW} + CAST(LEAST(ROUND(CAST(? AS DOUBLE PRECISION)), ${MAX_TIME}) AS BIGINT), ${MAX_TIME})`,
  json: (column, field) => `(${column}::jsonb ->> '${field}')`,
  serializeWebhook: delivery => JSON.stringify({
    payload: JSON.stringify(delivery),
    channelDeliveryId: JSON.stringify(delivery.channelDeliveryId),
    debounceKey: JSON.stringify(delivery.debounceKey),
  }),
  webhookPayload: decodeWebhookPayload,
  encodeWebhookKey: value => JSON.stringify(value),
  decodeWebhookKey,
  supersededValue: `CASE WHEN (value::jsonb ->> 'channelDeliveryId') IS NULL THEN '{}'
  ELSE jsonb_build_object('channelDeliveryId', value::jsonb ->> 'channelDeliveryId')::text END`,
  transcriptKeys: "key LIKE 'chat:%:transcripts:user:%' OR key LIKE 'transcripts:user:%'",
  placeholders: (statement) => {
    let index = 0
    return statement.replace(/\?/g, () => `$${++index}`)
  },
  migrate: migratePostgresTables,
}

function postgresDriver(client: () => AgentInvocationPostgresClient, tablePrefix: string): SqliteAgentStateDriver {
  const lockKey = `vitehub_agent_state:${tablePrefix}`
  return {
    connect: () => { client() },
    execute: async (statement, args) => await executor(client()).execute(statement, args),
    transaction: async run => await client().begin(async (sql) => {
      await sql.unsafe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
      await sql.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey])
      return await run(executor(sql))
    }),
  }
}

function postgresAgentState(client: () => AgentInvocationPostgresClient, options: Omit<PostgresAgentStateOptions, "client">): ViteHubSqliteAgentStateAdapter {
  const tablePrefix = (options.tablePrefix ?? "vitehub_agent_state_").replace(/[A-Z]/g, letter => letter.toLowerCase())
  if (tablePrefix.length > MAX_TABLE_PREFIX_LENGTH) {
    throw agentDiagnostics.AGENT_R0849({ message: `[vitehub] The Postgres Agent State tablePrefix "${tablePrefix}" is longer than ${MAX_TABLE_PREFIX_LENGTH} characters. Postgres cuts longer table and index names.` })
  }
  const { database: _database, durable, ...state } = options
  return new ViteHubSqliteAgentStateAdapter({ ...state, durable: durable !== false, driver: postgresDriver(client, tablePrefix), tablePrefix }, postgresAgentStateDialect)
}

/**
 * Agent State in Postgres, with the same tables and behavior as the SQLite store. Expiry uses the database clock.
 * The store creates its tables on first use.
 */
export function createPostgresAgentState(options: PostgresAgentStateOptions): ViteHubSqliteAgentStateAdapter {
  const { client, ...state } = options
  const database = options.database ?? "postgres"
  return postgresAgentState(() => agentInvocationPostgresClient(client, database, agentDiagnostics.AGENT_STATE_POSTGRES_DRIVER_UNSUPPORTED), state)
}

/** Agent State in a ViteHub Database that runs on Postgres. A Database on another dialect fails with `AGENT_STATE_DATABASE_NOT_POSTGRES`. */
export function createDatabaseAgentState(options: DatabaseAgentStateOptions = {}): ViteHubSqliteAgentStateAdapter {
  const database = options.database ?? "default"
  return postgresAgentState(() => {
    // SAFETY: Generated registry types restrict Database names. The runtime lookup accepts any name and throws `DATABASE_NOT_FOUND` when it is absent.
    const db = (useDatabase as (name: string) => { db: { $client?: unknown } })(database).db
    if (!is(db, PgAsyncDatabase)) throw agentDiagnostics.AGENT_STATE_DATABASE_NOT_POSTGRES({ database })
    return agentInvocationPostgresClient(db.$client, database, agentDiagnostics.AGENT_STATE_POSTGRES_DRIVER_UNSUPPORTED)
  }, { ...options, database })
}
