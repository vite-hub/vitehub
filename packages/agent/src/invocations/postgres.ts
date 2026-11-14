import { bigint, foreignKey, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

import { postgresAgentInvocationTableNames } from "./postgres-table-names.ts"

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

/** The Postgres journal tables with the default `vitehub_agent_` prefix, as a Drizzle schema object. */
export const agentInvocationsPostgresSchema: { agentInvocations: PgTable, agentInvocationObservations: PgTable } = {
  agentInvocations: tables.invocations,
  agentInvocationObservations: tables.observations,
}
