// The Console journal loads this module on first use, so a server that records no run does not load libSQL or Drizzle.
import { createClient } from "@libsql/client"
import { createLibsqlAgentInvocationStore } from "@vite-hub/agent/invocations/sqlite"
import { drizzle as drizzleRemote } from "drizzle-orm/sqlite-proxy"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

import { createConsoleUsageIndex } from "./usage-index.ts"

import type { AgentInvocationRecord, AgentInvocationStore, AgentInvocationSummary } from "@vite-hub/agent"
import type { AgentInvocationD1Database, AgentInvocationD1Statement } from "@vite-hub/agent/invocations/d1"
import type { AgentRetentionPolicy } from "@vite-hub/agent/server"
import type { Client } from "@libsql/client"
import type { LibSQLDatabase } from "drizzle-orm/libsql"
import type { AnySQLiteColumn, BaseSQLiteDatabase, SQLiteTableWithColumns } from "drizzle-orm/sqlite-core"
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

type ConsoleInvocationColumn<Data, NotNull extends boolean, HasDefault extends boolean = false> = AnySQLiteColumn<{
  data: Data
  hasDefault: HasDefault
  notNull: NotNull
  tableName: "vitehub_agent_invocations"
}> & { _: { generated: undefined } }

type ConsoleInvocationsTable<Nullable extends boolean> = SQLiteTableWithColumns<{
  columns: {
    agentName: ConsoleInvocationColumn<string, true, true>
    id: ConsoleInvocationColumn<string, true>
    record: ConsoleInvocationColumn<Omit<AgentInvocationRecord, "cursor">, true>
    search: ConsoleInvocationColumn<string, Nullable extends true ? false : true>
    sequence: ConsoleInvocationColumn<number, true, true>
    status: ConsoleInvocationColumn<string, true>
    summary: ConsoleInvocationColumn<Omit<AgentInvocationSummary, "cursor">, Nullable extends true ? false : true>
    updatedAt: ConsoleInvocationColumn<string, true, true>
  }
  dialect: "sqlite"
  name: "vitehub_agent_invocations"
  schema: undefined
}>

// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Drizzle's inferred table type cannot be emitted under isolatedDeclarations, so keep the public schema explicit here.
// SAFETY: The explicit table type mirrors the libSQL journal columns constructed immediately below.
const consoleInvocationsTable = sqliteTable("vitehub_agent_invocations", {
  sequence: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull().unique(),
  status: text().notNull(),
  agentName: text("agent_name").notNull().default(""),
  search: text(),
  summary: text({ mode: "json" }).$type<Omit<AgentInvocationSummary, "cursor">>(),
  updatedAt: text("updated_at").notNull().default(""),
  record: text({ mode: "json" }).$type<Omit<AgentInvocationRecord, "cursor">>().notNull(),
}) as unknown as ConsoleInvocationsTable<true>

// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Drizzle's inferred table type cannot be emitted under isolatedDeclarations, so keep the public schema explicit here.
// SAFETY: The explicit table type mirrors the D1 journal columns constructed immediately below.
const consoleD1InvocationsTable = sqliteTable("vitehub_agent_invocations", {
  sequence: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull().unique(),
  status: text().notNull(),
  agentName: text("agent_name").notNull().default(""),
  search: text().notNull(),
  summary: text({ mode: "json" }).$type<Omit<AgentInvocationSummary, "cursor">>().notNull(),
  updatedAt: text("updated_at").notNull().default(""),
  record: text({ mode: "json" }).$type<Omit<AgentInvocationRecord, "cursor">>().notNull(),
}) as unknown as ConsoleInvocationsTable<false>

const consoleInvocationSchema: { invocations: typeof consoleInvocationsTable } = {
  invocations: consoleInvocationsTable,
}
const consoleD1InvocationSchema: { invocations: typeof consoleD1InvocationsTable } = {
  invocations: consoleD1InvocationsTable,
}

/**
 * Drizzle over the Console journal of either driver. Both are async SQLite databases with the same columns, so one type
 * queries both: a union of the two clients has no callable `select()`. Reads use the libSQL columns, where `search` and
 * `summary` can be null. `schema` keeps the exact columns of each driver for inserts. Each branch also keeps its concrete
 * client so narrowing restores driver-specific query results and APIs.
 */
export type ConsoleInvocationsClient = BaseSQLiteDatabase<"async", unknown, typeof consoleInvocationSchema>
  & Pick<SqliteRemoteDatabase<typeof consoleInvocationSchema>, "batch">

export type ConsoleInvocationsDatabase = ({
  driver: "libsql"
  db: LibSQLDatabase<typeof consoleInvocationSchema> & { $client: Client }
  schema: typeof consoleInvocationSchema
} | {
  driver: "d1"
  db: SqliteRemoteDatabase<typeof consoleInvocationSchema>
  schema: typeof consoleD1InvocationSchema
}) & {
  db: ConsoleInvocationsClient
}

export interface ConsoleLibsqlJournal {
  database: ConsoleInvocationsDatabase
  store: Required<AgentInvocationStore>
  usageIndex: ReturnType<typeof createConsoleUsageIndex>
}

/** Opens the libSQL Console journal. The store, the usage index, and Drizzle share one client. */
export function openConsoleLibsqlJournal(options: { authToken?: string, url: string }, retention?: AgentRetentionPolicy): ConsoleLibsqlJournal {
  const client = createClient(options)
  try {
    return {
      database: { driver: "libsql", db: drizzle(client, { schema: consoleInvocationSchema }), schema: consoleInvocationSchema },
      store: createLibsqlAgentInvocationStore({
        client,
        maxAge: retention?.maxAge === undefined ? false : retention.maxAge,
        maxRecords: retention?.maxRecords === undefined ? false : retention.maxRecords,
        maxSize: retention?.maxSize === undefined ? false : retention.maxSize,
      }),
      usageIndex: createConsoleUsageIndex(client),
    }
  }
  catch (error) {
    client.close()
    throw error
  }
}

export interface ConsoleD1Statement extends AgentInvocationD1Statement {
  bind(...values: unknown[]): ConsoleD1Statement
  raw(): Promise<unknown[][]>
}

export interface ConsoleD1Database extends AgentInvocationD1Database {
  prepare(query: string): ConsoleD1Statement
}

/** Drizzle over the D1 Console journal. `database` returns the migrated binding of the current Worker request. */
export function createConsoleD1Database(database: () => Promise<ConsoleD1Database>): ConsoleInvocationsDatabase {
  // The Drizzle schema only types relational reads, so the D1 client reads with the shared, nullable columns.
  const db = drizzleRemote(async (query, parameters, method) => {
    const binding = await database()
    const statement = binding.prepare(query).bind(...parameters)
    const rows = await statement.raw()
    return { rows: method === "get" ? rows[0]! : rows }
  }, async (queries) => {
    const binding = await database()
    const results = await binding.batch(queries.map(query => binding.prepare(query.sql).bind(...query.params)))
    return results.map((result, index) => {
      const rows = (result.results ?? []).map(row => Object.values(row))
      return { rows: queries[index]!.method === "get" ? rows[0]! : rows }
    })
  }, { schema: consoleInvocationSchema })
  // D1 cannot keep Drizzle's separate BEGIN/query/COMMIT calls in one transaction.
  db.transaction = async () => {
    throw viteHubErrorDiagnostics.VITE_HUB_R0123({ message: "[vitehub] The D1 Console journal does not support db.transaction(). Use db.batch() for atomic writes." })
  }
  return { driver: "d1", db, schema: consoleD1InvocationSchema }
}
