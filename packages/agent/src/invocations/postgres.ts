import { bigint, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

import { defaultAgentJournalPostgresPrefix, postgresAgentInvocationTableNames } from "./postgres-table-names.ts"

import type { PgTable } from "drizzle-orm/pg-core"

/**
 * The two journal tables. Their column types stay internal: application code reads the journal through the
 * `AgentInvocationStore` API, not through these tables.
 */
export interface PostgresAgentInvocationTables {
  invocations: PgTable
  observations: PgTable
}

/**
 * The Drizzle tables of the Postgres Agent Invocation journal. Add them to the schema of a Postgres Database
 * Definition, then `vitehub database generate` writes their migration. ViteHub adds them to the target Database of
 * `invocations: 'database'` for you. Call this function yourself only for another `tablePrefix`.
 *
 * - `invocations` keeps one row per Invocation: the record and its summary as JSON text, the columns that lists filter
 *   on, and the claim of the run that owns the Invocation.
 * - `observations` keeps the observations that a running Invocation appends, one row each. The terminal update moves
 *   them into the record.
 */
export function postgresAgentInvocationTables(options: { tablePrefix?: string } = {}): PostgresAgentInvocationTables {
  const names = postgresAgentInvocationTableNames(options.tablePrefix)
  const invocations = pgTable(names.invocations, {
    sequence: bigint("sequence", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    id: text("id").notNull().unique(),
    status: text("status").notNull(),
    agentName: text("agent_name").notNull(),
    traceId: text("trace_id").notNull(),
    search: text("search").notNull(),
    summary: text("summary").notNull(),
    capabilityIds: jsonb("capability_ids").$type<string[]>().notNull(),
    triggeredBy: text("triggered_by"),
    updatedAt: text("updated_at").notNull(),
    record: text("record").notNull(),
    revision: integer("revision").notNull().default(0),
    claimId: text("claim_id"),
    claimToken: text("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true, mode: "string" }),
  }, table => [
    index(`${names.invocations}_status_sequence`).on(table.status, table.sequence.desc()),
    index(`${names.invocations}_status_updated_at`).on(table.status, table.updatedAt),
    index(`${names.invocations}_agent_name_sequence`).on(table.agentName, table.sequence.desc()),
  ])
  const observations = pgTable(names.observations, {
    position: bigint("position", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    invocationSequence: bigint("invocation_sequence", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    observation: text("observation").notNull(),
  }, table => [
    index(`${names.observations}_invocation`).on(table.invocationSequence, table.position),
    // The generated name is longer than the 63 bytes that Postgres keeps.
    foreignKey({ name: `${names.observations}_invocation_fk`, columns: [table.invocationSequence], foreignColumns: [invocations.sequence] }).onDelete("cascade"),
  ])
  return { invocations, observations }
}

const tables = postgresAgentInvocationTables()

const agentChatStreams = pgTable("vitehub_agent_chat_streams", {
  sequence: bigint("sequence", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  id: text("id").notNull().unique(),
  latest: text("latest").notNull(),
  state: text("state").notNull(),
  status: integer("status").notNull().default(200),
  statusText: text("status_text").notNull().default(""),
  headers: text("headers").notNull().default("[]"),
  hasBody: integer("has_body").notNull().default(0),
  error: text("error"),
  aliveAt: bigint("alive_at", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
}, table => [
  index("vitehub_agent_chat_streams_latest").on(table.latest, table.sequence),
  index("vitehub_agent_chat_streams_expires_at").on(table.expiresAt),
])

const agentChatStreamChunks = pgTable("vitehub_agent_chat_stream_chunks", {
  stream: bigint("stream", { mode: "number" }).notNull(),
  position: integer("position").notNull(),
  data: text("data").notNull(),
}, table => [
  primaryKey({ name: "vitehub_agent_chat_stream_chunks_pk", columns: [table.stream, table.position] }),
  foreignKey({ name: "vitehub_agent_chat_stream_chunks_stream_fk", columns: [table.stream], foreignColumns: [agentChatStreams.sequence] }).onDelete("cascade"),
])

/**
 * The Postgres journal tables with the default `vitehub_agent_` prefix, as a Drizzle schema object. It also holds the
 * streams of web chat routes with `resumable.scope: "shared"`: one row per stream, and its bytes as chunk rows.
 */
export const agentInvocationsPostgresSchema: { agentInvocations: PgTable, agentInvocationObservations: PgTable, agentChatStreams: PgTable, agentChatStreamChunks: PgTable } = {
  agentInvocations: tables.invocations,
  agentInvocationObservations: tables.observations,
  agentChatStreams,
  agentChatStreamChunks,
}

const defaultJournal = postgresAgentInvocationTables({ tablePrefix: defaultAgentJournalPostgresPrefix })

export const agentDefaultJournalPostgresSchema: { agentDefaultInvocations: PgTable, agentDefaultInvocationObservations: PgTable } = {
  agentDefaultInvocations: defaultJournal.invocations,
  agentDefaultInvocationObservations: defaultJournal.observations,
}
