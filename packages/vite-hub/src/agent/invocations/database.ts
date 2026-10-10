import { sql, type SQL } from "drizzle-orm"
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core"
import type { SQLiteRaw } from "drizzle-orm/sqlite-core/query-builders/raw"
import { useDatabase } from "@vite-hub/database/drizzle"
import { createD1AgentInvocationStore } from "@vite-hub/agent/invocations/d1"

import type { AgentInvocationD1Database, D1AgentInvocationStoreOptions } from "@vite-hub/agent/invocations/d1"
import type { AgentInvocationStore } from "@vite-hub/agent"

export interface DatabaseAgentInvocationStoreOptions extends Omit<D1AgentInvocationStoreOptions, "database"> {
  /** ViteHub database name. Defaults to "default". */
  database?: string
}

interface RuntimeConnection {
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

interface InvocationResult<T extends Record<string, unknown> = Record<string, unknown>> {
  meta: { changes: number }
  results: T[]
}

interface InvocationStatement {
  all<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<InvocationResult<T>>
  bind(...values: unknown[]): InvocationStatement
  querySql: SQL
}

interface InvocationDatabase {
  prepare(query: string): InvocationStatement
  batch(statements: InvocationStatement[]): Promise<InvocationResult[]>
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

function statementResult<T extends Record<string, unknown>>(rows: unknown[]): InvocationResult<T> {
  if (rows.some(row => typeof row !== "object" || row === null || Array.isArray(row))) {
    throw new TypeError("[vitehub] Database Agent Invocations require a driver that returns named columns. The Cloudflare D1 HTTP driver is not supported.")
  }
  return {
    meta: { changes: rows.length },
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
  if (!isRecord(value) || typeof Reflect.get(value, "prepare") !== "function" || typeof Reflect.get(value, "batch") !== "function") return
  // SAFETY: The runtime shape check verifies the D1 prepare and batch methods used by this adapter.
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
        all: async <T extends Record<string, unknown> = Record<string, unknown>>() => statementResult(await database.all<T>(query())),
        bind: (...next: unknown[]) => create(next),
        get querySql() {
          return query()
        },
      }
    }
    return create([])
  }

  return {
    async batch(statements) {
      const results = await runBatch(database, statements.map(statement => statement.querySql))
      return results.map(result => statementResult(result))
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
      // SAFETY: The local adapter implements the D1 contract. The cast bridges workspace source and package declaration identities during development.
      return adapter as unknown as AgentInvocationD1Database
    },
  })
}
