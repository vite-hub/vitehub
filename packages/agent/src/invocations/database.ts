import { sql, type SQL } from "drizzle-orm"
import { SQLiteDialect } from "drizzle-orm/sqlite-core"
import type { SQLiteAsyncRaw } from "drizzle-orm/sqlite-core"
import { useDatabase } from "@vite-hub/database"
import { trackD1Database, trackPostgresClient } from "@vite-hub/database/runtime/request-stats"
import { createD1AgentInvocationStore } from "./d1.ts"
import { createPostgresAgentInvocationStore } from "./postgres-store.ts"

import type { AgentInvocationD1Database, AgentInvocationD1Statement, D1AgentInvocationStoreOptions } from "./d1.ts"
import type { AgentInvocationStore } from "../invocations.ts"
import type { AgentInvocationPostgresClient } from "./postgres-store.ts"

/** `migrate` applies only to SQLite, libSQL, and D1. A Postgres Database gets its tables from its migrations. */
export interface DatabaseAgentInvocationStoreOptions extends Omit<D1AgentInvocationStoreOptions, "database"> {
  /** ViteHub database name. Defaults to "default". */
  database?: string
}

interface RuntimeConnection {
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- SQLiteAsyncRaw supplies the typed projection to this driver boundary.
  all<T extends Record<string, unknown> = Record<string, unknown>>(query: SQL): SQLiteAsyncRaw<T[]>
}

type RuntimeDatabase = RuntimeConnection & {
  batch(queries: readonly [SQLiteAsyncRaw<Record<string, unknown>[]>, ...Array<SQLiteAsyncRaw<Record<string, unknown>[]>>]): Promise<unknown[]>
  $client?: unknown
}

interface RuntimeD1Client {
  prepare(query: string): RuntimeD1Statement
  batch(statements: RuntimeD1BoundStatement[]): Promise<unknown[]>
}

interface RuntimeD1Statement {
  bind(...values: unknown[]): RuntimeD1BoundStatement
}

interface RuntimeD1BoundStatement {}

interface InvocationResult<T = Record<string, unknown>> {
  meta: { changes: number }
  results: T[]
}

interface InvocationStatement extends AgentInvocationD1Statement {
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- The caller chooses the named row projection returned by its SQL statement.
  all<T = Record<string, unknown>>(): Promise<InvocationResult<T>>
  bind(...values: unknown[]): InvocationStatement
  querySql: SQL
}

interface InvocationDatabase extends AgentInvocationD1Database {
  prepare(query: string): InvocationStatement
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- The D1 contract selects the row projection for each SQL batch.
  batch<T = Record<string, unknown>>(statements: InvocationStatement[]): Promise<InvocationResult<T>[]>
}

const writeStatement = /^\s*(?:INSERT|UPDATE|DELETE)\b/i
const returningClause = /\bRETURNING\b/i
const sqliteDialect = new SQLiteDialect()

function statementSql(query: string, values: readonly unknown[]): SQL {
  const parts = query.split("?")
  if (parts.length - 1 !== values.length) {
    throw new TypeError("[vitehub] Database Agent Invocation statement parameters do not match its placeholders.")
  }
  return sql.join(parts.map((part, index) => index === 0 ? sql.raw(part) : sql`${values[index - 1]}${sql.raw(part)}`))
}

// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- The caller supplies the row projection after the runtime named-column check.
function statementResult<T = Record<string, unknown>>(rows: unknown[]): InvocationResult<T> {
  if (rows.some(row => typeof row !== "object" || row === null || Array.isArray(row))) {
    throw new TypeError("[vitehub] Database Agent Invocations require a driver that returns named columns. The Cloudflare D1 HTTP driver is not supported.")
  }
  return {
    meta: { changes: rows.length },
    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- The runtime guard establishes the row shape before applying the caller's projection type.
    // SAFETY: The runtime check above verifies every result is a named row object.
    results: rows as T[],
  }
}

async function runBatch(database: RuntimeDatabase, queries: readonly SQL[]): Promise<unknown[][]> {
  const [first, ...rest] = queries
  if (!first) return []
  const statements = queries.map(query => sqliteDialect.sqlToQuery(query))
  // `$client` is the raw binding or session, so count the batch in the request's database stats here.
  const raw = d1Client(database.$client)
  const client = raw && trackD1Database(raw)
  if (client) {
    const results = await client.batch(statements.map(statement => client.prepare(statement.sql).bind(...statement.params)))
    return results.map(result => {
      if (!isRecord(result)) throw new TypeError("[vitehub] Database Agent Invocations require a D1 batch driver that returns results.")
      const rows = Reflect.get(result, "results")
      if (!Array.isArray(rows)) throw new TypeError("[vitehub] Database Agent Invocations require a D1 batch driver that returns rows.")
      return rows
    })
  }
  const results = await database.batch([database.all(first), ...rest.map(query => database.all(query))])
  return results.map(result => {
    if (!Array.isArray(result)) throw new TypeError("[vitehub] Database Agent Invocations require a SQLite batch driver that returns rows.")
    return result
  })
}

function d1Client(value: unknown): RuntimeD1Client | undefined {
  if (!isRecord(value) || typeof Reflect.get(value, "prepare") !== "function" || typeof Reflect.get(value, "batch") !== "function") return
  // SAFETY: The runtime shape check verifies the D1 prepare and batch methods used by this adapter.
  // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- The shape guard establishes the methods used by this adapter.
  return value as unknown as RuntimeD1Client
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function invocationDatabase(database: RuntimeDatabase): InvocationDatabase {
  const prepare = (query: string): InvocationStatement => {
    const text = writeStatement.test(query) && !returningClause.test(query) ? `${query} RETURNING 1 AS vitehub_changed` : query
    const create = (values: readonly unknown[]): InvocationStatement => {
      const query = (): SQL => statementSql(text, values)
      return {
        all: async <T = Record<string, unknown>>() => statementResult<T>(await database.all<T & Record<string, unknown>>(query())),
        bind: (...next: unknown[]) => create(next),
        get querySql() {
          return query()
        },
      }
    }
    return create([])
  }

  return {
    async batch<T = Record<string, unknown>>(statements: InvocationStatement[]) {
      const results = await runBatch(database, statements.map(statement => statement.querySql))
      return results.map(result => statementResult<T>(result))
    },
    prepare,
  }
}

/** A postgres.js client, as the Drizzle database of a Postgres Database Definition holds it in `$client`. */
function postgresClient(value: unknown): AgentInvocationPostgresClient | undefined {
  if (typeof value !== "function" || typeof Reflect.get(value, "begin") !== "function" || typeof Reflect.get(value, "unsafe") !== "function") return
  // SAFETY: The runtime shape check verifies the postgres.js begin and unsafe methods used by the Postgres store.
  // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- The shape guard establishes the methods used by this adapter.
  return value as unknown as AgentInvocationPostgresClient
}

/**
 * Agent Invocation store backed by a ViteHub Database. On SQLite, libSQL, and D1 it creates its table on first use.
 * On Postgres it uses the tables of `postgresAgentInvocationTables()`, which the Database migrations create.
 */
export function createDatabaseAgentInvocationStore(options: DatabaseAgentInvocationStoreOptions = {}): AgentInvocationStore {
  const { database: name = "default", ...storeOptions } = options
  const adapters = new WeakMap<object, InvocationDatabase>()
  const trackedClients = new WeakMap<AgentInvocationPostgresClient, AgentInvocationPostgresClient>()
  // SAFETY: Generated registry types restrict database names; the runtime lookup accepts any name and throws `DATABASE_NOT_FOUND` when it is absent.
  const runtime = (): RuntimeDatabase => (useDatabase as (database: string) => { db: RuntimeDatabase })(name).db
  const sqlite = createD1AgentInvocationStore({
    ...storeOptions,
    async database() {
      const runtimeDatabase = runtime()
      // Runtime proxies can change drivers between requests; validate each operation before any writes.
      for (const rows of await runBatch(runtimeDatabase, [sql`SELECT 1 AS vitehub_probe`])) statementResult(rows)
      const client = runtimeDatabase.$client
      const identity = isRecord(client) ? client : runtimeDatabase
      let adapter = adapters.get(identity)
      if (!adapter) {
        adapter = invocationDatabase(runtimeDatabase)
        adapters.set(identity, adapter)
      }
      return adapter
    },
  })
  const { migrate: _migrate, ...postgresOptions } = storeOptions
  // Created on the first Postgres operation, so a tablePrefix that only SQLite accepts does not fail a SQLite Database.
  let postgres: Required<Omit<AgentInvocationStore, "open">> | undefined
  const postgresStore = () => postgres ??= createPostgresAgentInvocationStore({
    ...postgresOptions,
    database: name,
    client() {
      const client = postgresClient(runtime().$client)
      // Internal invariant: the driver was Postgres when this store was created.
      if (!client) throw new TypeError(`[vitehub] Database "${name}" changed from Postgres to another driver.`)
      // Count the journal's queries in the request's database stats. One tracked client per pool keeps the table check cached.
      let tracked = trackedClients.get(client)
      if (!tracked) {
        tracked = trackPostgresClient(client)
        trackedClients.set(client, tracked)
      }
      return tracked
    },
  })
  // A runtime proxy resolves its driver per request, so each operation picks the store for the current client.
  const store = (): Required<Omit<AgentInvocationStore, "open">> => postgresClient(runtime().$client) ? postgresStore() : sqlite
  return {
    claim: async (...args) => await store().claim(...args),
    create: async input => await store().create(input),
    delete: async id => await store().delete(id),
    get: async (...args) => await store().get(...args),
    getClaimToken: async id => await store().getClaimToken(id),
    getSummary: async id => await store().getSummary(id),
    list: async listOptions => await store().list(listOptions),
    listAgentNames: async () => await store().listAgentNames(),
    listCapabilityIds: async agentName => await store().listCapabilityIds(agentName),
    listTriggeredBy: async agentName => await store().listTriggeredBy(agentName),
    prune: async pruneOptions => await store().prune(pruneOptions),
    release: async (...args) => await store().release(...args),
    update: async (...args) => await store().update(...args),
  }
}
