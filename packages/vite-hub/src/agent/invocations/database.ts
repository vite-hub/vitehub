import { sql, type SQL } from "drizzle-orm"
import { useDatabase } from "@vite-hub/database/drizzle"
import { createD1AgentInvocationStore } from "@vite-hub/agent/invocations/d1"

import type { AgentInvocationD1Database, D1AgentInvocationStoreOptions } from "@vite-hub/agent/invocations/d1"
import type { AgentInvocationStore } from "@vite-hub/agent"

export interface DatabaseAgentInvocationStoreOptions extends Omit<D1AgentInvocationStoreOptions, "database"> {
  /** ViteHub database name. Defaults to "default". */
  database?: string
}

interface RuntimeConnection {
  all<T extends Record<string, unknown> = Record<string, unknown>>(query: SQL): Promise<T[]>
}

type RuntimeDatabase = RuntimeConnection & {
  transaction?<T>(callback: (connection: RuntimeConnection) => Promise<T>): Promise<T>
}

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

function statementSql(query: string, values: readonly unknown[]): SQL {
  const parts = query.split("?")
  if (parts.length - 1 !== values.length) {
    throw new TypeError("[vitehub] Database Agent Invocation statement parameters do not match its placeholders.")
  }
  return sql.join(parts.map((part, index) => index === 0 ? sql.raw(part) : sql`${values[index - 1]}${sql.raw(part)}`))
}

function statementResult<T extends Record<string, unknown>>(rows: T[]): InvocationResult<T> {
  if (rows.some(Array.isArray)) {
    throw new TypeError("[vitehub] Database Agent Invocations require a driver that returns named columns. The Cloudflare D1 HTTP driver is not supported.")
  }
  return {
    meta: { changes: rows.length },
    results: rows,
  }
}

async function runBatch(database: RuntimeDatabase, queries: readonly SQL[]): Promise<Record<string, unknown>[][]> {
  const execute = async (connection: RuntimeConnection) => {
    const results: Record<string, unknown>[][] = []
    for (const query of queries) results.push(await connection.all(query))
    return results
  }
  return database.transaction ? database.transaction(execute) : execute(database)
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
      const entry = (useDatabase as unknown as (database: string) => { db: RuntimeDatabase } | undefined)(name)
      if (!entry) throw new TypeError(`[vitehub] Database "${name}" is not configured.`)
      const runtime = entry.db as unknown as RuntimeDatabase
      adapter ??= invocationDatabase(runtime)
      // SAFETY: The local adapter implements the D1 contract. The cast bridges workspace source and package declaration identities during development.
      return adapter as unknown as AgentInvocationD1Database
    },
    // SAFETY: The options object supplies the D1 database factory above. The cast bridges workspace source and package declaration identities during development.
  } as unknown as D1AgentInvocationStoreOptions)
}
