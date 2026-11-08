// `getAgentInvocationsDatabase()` loads this module on first use, so a server that never queries the journal does not load Drizzle.
import { drizzle as drizzleRemote } from "drizzle-orm/sqlite-proxy"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

import type { AgentInvocationRecord, AgentInvocationSummary } from "@vite-hub/agent"
import type { DefaultAgentInvocationsD1Database } from "@vite-hub/agent/invocations/default"
import type { Client } from "@libsql/client"
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy"
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

/**
 * Drizzle over the default Agent Invocation journal. Check `driver` before destructuring to narrow the database
 * and schema. D1 inserts require non-null `search` and `summary`; libSQL reads allow null while legacy rows await backfill.
 */
export type AgentInvocationsDatabase = {
  driver: "libsql"
  db: LibSQLDatabase<typeof libsqlInvocationSchema>
  schema: typeof libsqlInvocationSchema
} | {
  driver: "d1"
  db: SqliteRemoteDatabase<typeof d1InvocationSchema>
  schema: typeof d1InvocationSchema
}

/** Drizzle over the libSQL client that the default journal uses. */
export function createLibsqlInvocationsDatabase(client: Client): AgentInvocationsDatabase {
  return { driver: "libsql", db: drizzle(client, { schema: libsqlInvocationSchema }), schema: libsqlInvocationSchema }
}

/** Drizzle over the D1 journal. `database` returns the migrated binding of the current Worker request. */
export function createD1InvocationsDatabase(database: () => Promise<DefaultAgentInvocationsD1Database>): AgentInvocationsDatabase {
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
  }, { schema: d1InvocationSchema })
  // D1 cannot keep Drizzle's separate BEGIN/query/COMMIT calls in one transaction.
  db.transaction = async () => {
    throw viteHubErrorDiagnostics.VITE_HUB_R0123({ message: "[vitehub] The D1 Agent Invocation journal does not support db.transaction(). Use db.batch() for atomic writes." })
  }
  return { driver: "d1", db, schema: d1InvocationSchema }
}
