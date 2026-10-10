import { sql, type SQL } from "drizzle-orm"
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core"
import type { SQLiteRaw } from "drizzle-orm/sqlite-core/query-builders/raw"
import { useDatabase } from "@vite-hub/database/drizzle"
import { createD1AgentInvocationStore } from "@vite-hub/agent/invocations/d1"

import type { AgentInvocationD1Database, AgentInvocationD1Statement, D1AgentInvocationStoreOptions } from "@vite-hub/agent/invocations/d1"
import type { AgentInvocationStore } from "@vite-hub/agent"

export interface DatabaseAgentInvocationStoreOptions extends Omit<D1AgentInvocationStoreOptions, "database"> {
  /** ViteHub database name. Defaults to "default". */
  database?: string
}

interface RuntimeConnection {
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- SQLiteRaw supplies the typed projection to this driver boundary.
  all<T extends Record<string, unknown> = Record<string, unknown>>(query: SQL): SQLiteRaw<T[]>
}

type RuntimeDatabase = RuntimeConnection & {
  batch(queries: readonly [SQLiteRaw<Record<string, unknown>[]>, ...Array<SQLiteRaw<Record<string, unknown>[]>>]): Promise<unknown[]>
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
const sqliteDialect = new SQLiteAsyncDialect()

function statementSql(query: string, values: readonly unknown[]): SQL {
  const parts = query.split("?")
  if (parts.length - 1 !== values.length) {
    throw new TypeError("[vitehub] Database Agent Invocation statement parameters do not match its placeholders.")
  }
  return sql.join(parts.map((part, index) => index === 0 ? sql.raw(part) : sql`${values[index - 1]}${sql.raw(part)}`))
}

// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- The caller supplies the row projection after the runtime named-column check.
function statementResult<T = Record<string, unknown>>(rows: unknown[]): InvocationResult<T> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- This boundary validates that a driver returned named row objects.
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
  const client = d1Client(database.$client)
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
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- This boundary checks the optional native D1 client methods before use.
  if (!isRecord(value) || typeof Reflect.get(value, "prepare") !== "function" || typeof Reflect.get(value, "batch") !== "function") return
  // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- The shape guard establishes the methods used by this adapter.
  // SAFETY: The runtime shape check verifies the D1 prepare and batch methods used by this adapter.
  return value as unknown as RuntimeD1Client
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- This is the runtime object guard for driver results.
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

/** Agent Invocation store backed by a ViteHub SQLite database. It creates its table on first use. */
export function createDatabaseAgentInvocationStore(options: DatabaseAgentInvocationStoreOptions = {}): AgentInvocationStore {
  const { database: name = "default", ...storeOptions } = options
  let adapter: InvocationDatabase | undefined
  return createD1AgentInvocationStore({
    ...storeOptions,
    async database() {
      // SAFETY: Generated registry types restrict database names; runtime lookup accepts any name and returns undefined when absent.
      const entry = (useDatabase as (database: string) => { db: RuntimeDatabase } | undefined)(name)
      if (!entry) throw new TypeError(`[vitehub] Database "${name}" is not configured.`)
      const runtime = entry.db
      // Runtime proxies can change drivers between requests; validate each operation before any writes.
      for (const rows of await runBatch(runtime, [sql`SELECT 1 AS vitehub_probe`])) statementResult(rows)
      adapter ??= invocationDatabase(runtime)
      if (!adapter) throw new TypeError("[vitehub] Database Agent Invocation adapter was not initialized.")
      return adapter
    },
  })
}
