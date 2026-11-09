// `getAgentInvocationsDatabase()` loads this module on first use, so a server that never queries the journal does not load Drizzle.
import { defineRelations } from "drizzle-orm"
import { d1Codecs } from "drizzle-orm/d1/codecs"
import { drizzle as drizzleRemote } from "drizzle-orm/sqlite-proxy"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

import type { AgentInvocationRecord, AgentInvocationSummary } from "@vite-hub/agent"
import type { DefaultAgentInvocationsD1Database } from "@vite-hub/agent/invocations/default"
import type { Client } from "@libsql/client"
import type { EmptyRelations, ExtractTablesWithRelations } from "drizzle-orm"
import type { SqliteProxyBatchItem, SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy"
import type { LibSQLDatabase } from "drizzle-orm/libsql"
import type { AnySQLiteColumn, SQLiteTableWithColumns } from "drizzle-orm/sqlite-core"
import { viteHubErrorDiagnostics } from "../../error-diagnostics.ts"

type AgentInvocationColumn<Data, NotNull extends boolean, HasDefault extends boolean = false> = AnySQLiteColumn<{
  data: Data
  hasDefault: HasDefault
  notNull: NotNull
  tableName: "vitehub_agent_invocations"
}> & { _: { generated: undefined } }

type AgentInvocationsTable<Nullable extends boolean> = SQLiteTableWithColumns<{
  columns: {
    agentName: AgentInvocationColumn<string, true, true>
    id: AgentInvocationColumn<string, true>
    record: AgentInvocationColumn<Omit<AgentInvocationRecord, "cursor">, true>
    search: AgentInvocationColumn<string, Nullable extends true ? false : true>
    sequence: AgentInvocationColumn<number, true, true>
    status: AgentInvocationColumn<string, true>
    summary: AgentInvocationColumn<Omit<AgentInvocationSummary, "cursor">, Nullable extends true ? false : true>
    updatedAt: AgentInvocationColumn<string, true, true>
  }
  dialect: "sqlite"
  isAlias: false
  name: "vitehub_agent_invocations"
  schema: undefined
}>

// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Drizzle's inferred table type cannot be emitted under isolatedDeclarations, so keep the public schema explicit here.
// SAFETY: The explicit table type mirrors the libSQL journal columns constructed immediately below.
const libsqlInvocationsTable = sqliteTable("vitehub_agent_invocations", {
  sequence: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull().unique(),
  status: text().notNull(),
  agentName: text("agent_name").notNull().default(""),
  search: text(),
  summary: text({ mode: "json" }).$type<Omit<AgentInvocationSummary, "cursor">>(),
  updatedAt: text("updated_at").notNull().default(""),
  record: text({ mode: "json" }).$type<Omit<AgentInvocationRecord, "cursor">>().notNull(),
}) as unknown as AgentInvocationsTable<true>

// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Drizzle's inferred table type cannot be emitted under isolatedDeclarations, so keep the public schema explicit here.
// SAFETY: The explicit table type mirrors the D1 journal columns constructed immediately below.
const d1InvocationsTable = sqliteTable("vitehub_agent_invocations", {
  sequence: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull().unique(),
  status: text().notNull(),
  agentName: text("agent_name").notNull().default(""),
  search: text().notNull(),
  summary: text({ mode: "json" }).$type<Omit<AgentInvocationSummary, "cursor">>().notNull(),
  updatedAt: text("updated_at").notNull().default(""),
  record: text({ mode: "json" }).$type<Omit<AgentInvocationRecord, "cursor">>().notNull(),
}) as unknown as AgentInvocationsTable<false>

const libsqlInvocationSchema: { invocations: typeof libsqlInvocationsTable } = {
  invocations: libsqlInvocationsTable,
}
const d1InvocationSchema: { invocations: typeof d1InvocationsTable } = {
  invocations: d1InvocationsTable,
}

// Each table, so `db.query.invocations` reads the journal.
const libsqlInvocationRelations: ExtractTablesWithRelations<EmptyRelations, typeof libsqlInvocationSchema> = defineRelations(libsqlInvocationSchema)
const d1InvocationRelations: ExtractTablesWithRelations<EmptyRelations, typeof d1InvocationSchema> = defineRelations(d1InvocationSchema)

/**
 * Drizzle over the default Agent Invocation journal. Check `driver` before destructuring to narrow the database
 * and schema. D1 inserts require non-null `search` and `summary`; libSQL reads allow null while legacy rows await backfill.
 */
export type AgentInvocationsDatabase = {
  driver: "libsql"
  db: LibSQLDatabase<typeof libsqlInvocationRelations>
  schema: typeof libsqlInvocationSchema
} | {
  driver: "d1"
  db: SqliteRemoteDatabase<unknown, typeof d1InvocationRelations>
  schema: typeof d1InvocationSchema
}

/** Drizzle over the libSQL client that the default journal uses. */
export function createLibsqlInvocationsDatabase(client: Client): AgentInvocationsDatabase {
  return { driver: "libsql", db: drizzle({ client, relations: libsqlInvocationRelations }), schema: libsqlInvocationSchema }
}

/** Drizzle over the D1 journal. `database` returns the migrated binding of the current Worker request. */
export function createD1InvocationsDatabase(database: () => Promise<DefaultAgentInvocationsD1Database>): AgentInvocationsDatabase {
  // D1 returns `raw()` rows as arrays, and `all()` and batch rows as objects by column name. The proxy driver decodes
  // no column modes by itself, so it gets the D1 codecs for the JSON columns.
  const rows = async (sql: string, parameters: unknown[], rowMode: "array" | "object" | undefined): Promise<unknown[]> => {
    const statement = (await database()).prepare(sql).bind(...parameters)
    return rowMode === "object" ? (await statement.all()).results ?? [] : await statement.raw()
  }
  const db = drizzleRemote({
    // SAFETY: Drizzle types each executor by row mode, and `rows` returns the rows of the mode that it gets.
    all: ((sql: string, parameters: unknown[], rowMode?: "array" | "object") => rows(sql, parameters, rowMode)) as Parameters<typeof drizzleRemote>[0]["all"],
    // SAFETY: As for `all`. A missing row is undefined.
    get: (async (sql: string, parameters: unknown[], rowMode?: "array" | "object") => (await rows(sql, parameters, rowMode))[0]) as Parameters<typeof drizzleRemote>[0]["get"],
    // The D1 contract of the journal has no `run()`; `raw()` runs a write too. A write resolves to `{ rows }`, as the
    // `sqlite-proxy` callback of Drizzle 0.x did.
    run: async (sql: string, parameters: unknown[]) => ({ rows: await rows(sql, parameters, "array") }),
    batch: async (queries: SqliteProxyBatchItem[]) => {
      const binding = await database()
      const results = await binding.batch(queries.map(query => binding.prepare(query.sql).bind(...query.params)))
      return results.map((result, index) => {
        const { method, rowMode } = queries[index]!
        const batchRows = (result.results ?? []).map(row => rowMode === "object" ? row : Object.values(row))
        return method === "get" ? batchRows[0] : method === "run" ? { rows: batchRows } : batchRows
      })
    },
  }, { codecs: d1Codecs, relations: d1InvocationRelations })
  // D1 cannot keep Drizzle's separate BEGIN/query/COMMIT calls in one transaction.
  db.transaction = async () => {
    throw viteHubErrorDiagnostics.VITE_HUB_R0123({ message: "[vitehub] The D1 Agent Invocation journal does not support db.transaction(). Use db.batch() for atomic writes." })
  }
  return { driver: "d1", db, schema: d1InvocationSchema }
}
