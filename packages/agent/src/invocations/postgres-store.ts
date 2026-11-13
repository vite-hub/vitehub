import { agentDiagnostics } from "../agent-diagnostics.ts"
import { applyAgentInvocationStoreUpdate } from "../invocations.ts"
import { d1AgentInvocationRetention } from "./d1-retention.ts"
import { normalizeAgentInvocationListOptions } from "./list-options.ts"
import { observationRowChanges, parsedObservation } from "./observation-rows.ts"
import { postgresAgentInvocationTableNames } from "./postgres-table-names.ts"
import { countRetentionDue } from "./retention.ts"
import { searchableAgentInvocationText } from "./search.ts"
import { sqlTrimWhitespace } from "./sql-whitespace.ts"

import type { AgentInvocationRecord, AgentInvocationStore, AgentInvocationStoreCreateInput, AgentInvocationSummary } from "../invocations.ts"
import type { AgentRetentionPolicy } from "../retention.ts"
import type { ObservationRow } from "./observation-rows.ts"
import type { TraceEventLogEntry } from "@vite-hub/runtime"

type PostgresValue = boolean | number | string | null
type PostgresRow = Record<string, unknown>

/** The postgres.js calls that the journal uses. A postgres.js `Sql` client and its transaction client satisfy it. */
export interface AgentInvocationPostgresQuery {
  unsafe(query: string, parameters?: PostgresValue[]): PromiseLike<readonly PostgresRow[]>
}

export interface AgentInvocationPostgresClient extends AgentInvocationPostgresQuery {
  begin<T>(run: (sql: AgentInvocationPostgresQuery) => Promise<T>): PromiseLike<T>
}

export interface PostgresAgentInvocationStoreOptions extends AgentRetentionPolicy {
  /** Resolved once per operation, so a host can give each request its own client. */
  client: () => AgentInvocationPostgresClient | Promise<AgentInvocationPostgresClient>
  /** ViteHub Database name, for diagnostics. */
  database?: string
  maxRecords?: false | number
  /** Not supported. The Database holds other tables. Use maxRecords or maxAge. */
  maxSize?: false
  tablePrefix?: string
}

const terminalStatuses = ["completed", "failed", "cancelled"] as const
const terminal = terminalStatuses.map(status => `'${status}'`).join(", ")
const observationInsertChunkSize = 200

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? String(item) : item)
}

/** Postgres text cannot hold U+0000. JSON text escapes it, so only plain text columns need this. */
function plainText(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function capabilityIds(record: Omit<AgentInvocationRecord, "cursor">): string[] {
  const ids = new Set<string>()
  const add = (value: unknown) => {
    // jsonb cannot hold U+0000, and no stored ID can contain it.
    const id = typeof value === "string" ? value.trim() : ""
    if (id && !id.includes("\u0000")) ids.add(id)
  }
  for (const id of record.capabilityIds ?? []) add(id)
  for (const observation of record.observations) add(observation.attributes?.["capability.id"])
  return [...ids]
}

function triggeredBy(record: Omit<AgentInvocationRecord, "cursor">): string | null {
  const value = record.annotations?.triggeredBy
  return typeof value === "string" ? plainText(value) : null
}

function summaryText(record: Omit<AgentInvocationRecord, "cursor">): string {
  const { observations: _observations, ...summary } = record
  return serialize(summary)
}

function storedRecord(record: AgentInvocationRecord): Omit<AgentInvocationRecord, "cursor"> {
  const { cursor: _cursor, ...stored } = record
  return stored
}

/** The values of the record columns, in the order of `recordColumns`. */
function recordValues(record: Omit<AgentInvocationRecord, "cursor">, recordRow: Omit<AgentInvocationRecord, "cursor"> = record): PostgresValue[] {
  return [
    record.status,
    plainText(record.agentName || ""),
    plainText(record.traceId),
    searchableAgentInvocationText(record),
    summaryText(record),
    JSON.stringify(capabilityIds(record)),
    triggeredBy(record),
    record.updatedAt,
    serialize(recordRow),
  ]
}

const recordColumns = ["status", "agent_name", "trace_id", "search", "summary", "capability_ids", "triggered_by", "updated_at", "record"]

function parseRecord(value: unknown, sequence: unknown): AgentInvocationRecord {
  // Internal invariant: this store writes the record column as text.
  if (typeof value !== "string") throw new TypeError("[vitehub] Postgres Agent Invocation rows must hold the record as text.")
  // SAFETY: The store writes this column from records that applyAgentInvocationStoreUpdate() produced.
  // doctor-disable-next-line typescript/boundaries/no-unvalidated-deserialization -- The store reads its own serialized AgentInvocationStoreCreateInput from its migrated table.
  const stored = JSON.parse(value) as AgentInvocationStoreCreateInput
  return { ...stored, cursor: String(sequence) }
}

function parseSummary(value: unknown, sequence: unknown): AgentInvocationSummary {
  // Internal invariant: this store writes the summary column as text.
  if (typeof value !== "string") throw new TypeError("[vitehub] Postgres Agent Invocation rows must hold the summary as text.")
  // SAFETY: The store writes summaries together with the full record.
  // doctor-disable-next-line typescript/boundaries/no-unvalidated-deserialization -- recordValues() writes the typed record metadata into this column in the same statement as the record.
  return { ...JSON.parse(value) as Omit<AgentInvocationSummary, "cursor">, cursor: String(sequence) }
}

/** Appended rows arrive as one comma-joined text of JSON objects, in position order. */
function parseAppended(value: string): TraceEventLogEntry[] {
  const parsed: unknown = JSON.parse(`[${value}]`)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is TraceEventLogEntry => typeof item === "object" && item !== null && typeof Reflect.get(item, "name") === "string")
}

function observationRows(rows: readonly PostgresRow[]): ObservationRow[] {
  return rows.flatMap((row) => {
    const observation = parsedObservation(row.observation)
    return observation ? [{ observation, position: Number(row.position) }] : []
  })
}

/**
 * Agent Invocation journal on a Postgres Database. The tables come from `postgresAgentInvocationTables()` and the
 * Database migrations. The store does not create them. Claims expire by the database clock, and each update locks
 * its record row in a transaction.
 */
export function createPostgresAgentInvocationStore(options: PostgresAgentInvocationStoreOptions): Required<Omit<AgentInvocationStore, "open">> {
  const names = postgresAgentInvocationTableNames(options.tablePrefix)
  const table = names.invocations
  const observationTable = names.observations
  const { maxAgeMs, maxRecords } = d1AgentInvocationRetention(options)
  const checked = new WeakSet<AgentInvocationPostgresClient>()
  const client = async () => {
    const sql = await options.client()
    if (checked.has(sql)) return sql
    const [row] = await sql.unsafe("SELECT to_regclass($1) IS NOT NULL AS invocations, to_regclass($2) IS NOT NULL AS observations", [table, observationTable])
    const missing = [row?.invocations === true ? undefined : table, row?.observations === true ? undefined : observationTable].filter(name => name !== undefined)
    if (missing.length) throw agentDiagnostics.AGENT_R1044({ database: options.database ?? "default", tables: missing })
    checked.add(sql)
    return sql
  }

  const read = async (sql: AgentInvocationPostgresQuery, id: string, observationNames?: readonly string[]): Promise<AgentInvocationRecord | undefined> => {
    // The name column drops U+0000, so a name with it skips this filter. The exact filter below still applies.
    const filter = observationNames !== undefined && !observationNames.some(name => name.includes("\u0000"))
    // One statement reads the record and its appended rows from one snapshot.
    const [row] = await sql.unsafe(`SELECT r.sequence::text AS sequence, r.record, (SELECT string_agg(o.observation, ',' ORDER BY o.position)
      FROM ${observationTable} o WHERE o.invocation_sequence = r.sequence${filter ? " AND o.name IN (SELECT jsonb_array_elements_text($2::text::jsonb))" : ""}) AS appended
      FROM ${table} r WHERE r.id = $1`, filter ? [id, JSON.stringify(observationNames)] : [id])
    if (!row) return
    const record = parseRecord(row.record, row.sequence)
    const appended = typeof row.appended === "string" ? parseAppended(row.appended) : []
    const observations = appended.length ? [...record.observations, ...appended] : record.observations
    if (observationNames === undefined) return appended.length ? { ...record, observations } : record
    const selected = new Set(observationNames)
    return { ...record, observations: observations.filter(observation => selected.has(observation.name)) }
  }

  // Each selection uses one index. The count limit merges three ordered status scans and stops at maxRecords.
  const ageSelection = (updatedBefore: string) => ({ values: [updatedBefore], where: `status IN (${terminal}) AND updated_at < $1` })
  const countSelection = (limit: number) => ({
    values: [limit - 1],
    where: `status IN (${terminal}) AND sequence < (SELECT sequence FROM (
      ${terminalStatuses.map(status => `SELECT sequence FROM ${table} WHERE status = '${status}'`).join(" UNION ALL ")}
    ) terminal_sequences ORDER BY sequence DESC LIMIT 1 OFFSET $1::bigint)`,
  })
  const pruneSelections = (count: boolean, updatedBefore?: string) => {
    if (updatedBefore !== undefined) return [ageSelection(updatedBefore)]
    return [
      ...(count && maxRecords !== false ? [countSelection(maxRecords)] : []),
      ...(maxAgeMs !== false ? [ageSelection(new Date(Date.now() - maxAgeMs).toISOString())] : []),
    ]
  }
  // SKIP LOCKED leaves a record that another transaction writes for a later prune, so retention never waits or deadlocks.
  const deleteSelection = (selection: { values: PostgresValue[], where: string }) =>
    `DELETE FROM ${table} WHERE sequence IN (SELECT sequence FROM ${table} WHERE ${selection.where} FOR UPDATE SKIP LOCKED) RETURNING id`
  const prune = async (sql: AgentInvocationPostgresQuery, count: boolean) => {
    for (const selection of pruneSelections(count)) await sql.unsafe(deleteSelection(selection), selection.values)
  }
  const insertObservations = async (sql: AgentInvocationPostgresQuery, sequence: string, observations: readonly TraceEventLogEntry[]) => {
    for (let start = 0; start < observations.length; start += observationInsertChunkSize) {
      const chunk = observations.slice(start, start + observationInsertChunkSize)
      await sql.unsafe(
        `INSERT INTO ${observationTable} (invocation_sequence, name, observation) VALUES ${chunk.map((_, index) => `($1::bigint, $${index * 2 + 2}, $${index * 2 + 3})`).join(", ")}`,
        [sequence, ...chunk.flatMap(observation => [plainText(observation.name), serialize(observation)])],
      )
    }
  }

  return {
    async create(input) {
      const sql = await client()
      const count = countRetentionDue(maxRecords)
      return await sql.begin(async (transaction) => {
        // Retention before the insert lets a retried ID replace its expired record.
        await prune(transaction, count)
        const inserted = await transaction.unsafe(
          `INSERT INTO ${table} (id, ${recordColumns.join(", ")}) VALUES ($1, ${recordColumns.map((column, index) => column === "capability_ids" ? `$${index + 2}::text::jsonb` : `$${index + 2}`).join(", ")})
            ON CONFLICT (id) DO NOTHING RETURNING sequence`,
          [input.id, ...recordValues(input)],
        )
        if (isTerminal(input.status)) await prune(transaction, count)
        const record = await read(transaction, input.id)
        if (!record) throw agentDiagnostics.AGENT_R0915({ message: `[vitehub] Postgres Agent Invocation ${JSON.stringify(input.id)} was removed by retention.` })
        return { created: inserted.length > 0, record }
      })
    },
    async delete(id) {
      const sql = await client()
      const deleted = await sql.unsafe(`DELETE FROM ${table} WHERE id = $1 AND status IN (${terminal}) RETURNING id`, [id])
      if (deleted.length) return "deleted"
      const [row] = await sql.unsafe(`SELECT 1 AS found FROM ${table} WHERE id = $1`, [id])
      return row ? "not-terminal" : "not-found"
    },
    async prune(pruneOptions) {
      const dryRun = pruneOptions.dryRun === true
      const selections = pruneSelections(true, pruneOptions.updatedBefore)
      if (!selections.length) return { dryRun, ids: [] }
      const sql = await client()
      const ids: string[] = []
      for (const selection of selections) {
        const rows = dryRun
          ? await sql.unsafe(`SELECT id FROM ${table} WHERE ${selection.where} ORDER BY sequence`, selection.values)
          : await sql.unsafe(deleteSelection(selection), selection.values)
        for (const row of rows) if (typeof row.id === "string" && !ids.includes(row.id)) ids.push(row.id)
      }
      return { dryRun, ids }
    },
    async get(id, getOptions) {
      return await read(await client(), id, getOptions?.observationNames)
    },
    async getSummary(id) {
      const sql = await client()
      const [row] = await sql.unsafe(`SELECT sequence::text AS sequence, summary FROM ${table} WHERE id = $1`, [id])
      return row ? parseSummary(row.summary, row.sequence) : undefined
    },
    async claim(id, claimId, leaseMs, claimOptions) {
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw agentDiagnostics.AGENT_R0916({ message: "[vitehub] Postgres Agent Invocation leaseMs must be a positive safe integer." })
      if (new TextEncoder().encode(claimId).byteLength > 512) throw agentDiagnostics.AGENT_R0917({ message: "[vitehub] Postgres Agent Invocation claimId must be at most 512 UTF-8 bytes." })
      // A cursor that is not a sequence names no record.
      if (claimOptions?.expectedCursor !== undefined && !/^[1-9]\d{0,15}$/.test(claimOptions.expectedCursor)) return false
      const sql = await client()
      const expectedClaimIds = claimOptions?.expectedClaimIds === undefined ? null : JSON.stringify(claimOptions.expectedClaimIds)
      // now() is the database clock, so hosts with different clocks agree on when a claim expires.
      const rows = await sql.unsafe(`UPDATE ${table}
        SET revision = revision + 1, claim_id = $2, claim_token = $3, claim_expires_at = now() + $4::bigint * interval '1 millisecond'
        WHERE id = $1 AND ($5::bigint IS NULL OR sequence = $5::bigint) AND ($6::text IS NULL OR trace_id = $6::text) AND (claim_id IS NULL
          OR ($7::text::jsonb IS NOT NULL AND $7::text::jsonb @> jsonb_build_array(claim_id))
          OR ($7::text::jsonb IS NULL AND ($8::boolean OR claim_id = $2 OR claim_expires_at <= now() OR ($9::text IS NOT NULL AND claim_token = $9::text))))
        RETURNING 1 AS claimed`, [
        id,
        claimId,
        crypto.randomUUID(),
        leaseMs,
        claimOptions?.expectedCursor ?? null,
        claimOptions?.expectedTraceId ?? null,
        expectedClaimIds,
        claimOptions?.replaceExisting === true,
        claimOptions?.replaceClaimToken ?? null,
      ])
      return rows.length > 0
    },
    async getClaimToken(id) {
      const sql = await client()
      const [row] = await sql.unsafe(`SELECT claim_token FROM ${table} WHERE id = $1`, [id])
      return typeof row?.claim_token === "string" ? row.claim_token : undefined
    },
    async release(id, claimId) {
      const sql = await client()
      await sql.unsafe(`UPDATE ${table} SET revision = revision + 1, claim_id = NULL, claim_token = NULL, claim_expires_at = NULL WHERE id = $1 AND claim_id = $2`, [id, claimId])
    },
    async update(id, input, claimId) {
      const sql = await client()
      const count = countRetentionDue(maxRecords)
      return await sql.begin(async (transaction) => {
        // The row lock makes concurrent updates of one Invocation run one after another, on every instance.
        const [row] = await transaction.unsafe(`SELECT sequence::text AS sequence, record, claim_id FROM ${table} WHERE id = $1 FOR UPDATE`, [id])
        if (!row || (claimId !== undefined && row.claim_id !== claimId)) return undefined
        const sequence = String(row.sequence)
        const stored = parseRecord(row.record, sequence)
        const rows = observationRows(await transaction.unsafe(
          `SELECT o.position::text AS position, o.observation FROM ${observationTable} o WHERE o.invocation_sequence = $1::bigint ORDER BY o.position`,
          [sequence],
        ))
        const record = rows.length ? { ...stored, observations: [...stored.observations, ...rows.map(item => item.observation)] } : stored
        const updated = applyAgentInvocationStoreUpdate(record, input)
        if (updated === record) return record
        const next = storedRecord(updated)
        const ended = isTerminal(updated.status)
        // A running record keeps appended observations in their own rows, so an append writes one small row and a
        // record column that does not grow. A terminal record holds every observation in its record column.
        const changes = ended ? undefined : observationRowChanges(stored.observations, rows, updated.observations)
        const recordRow = { ...next, observations: ended ? next.observations : changes ? stored.observations : [] }
        await transaction.unsafe(
          `UPDATE ${table} SET ${recordColumns.map((column, index) => `${column} = $${index + 2}${column === "capability_ids" ? "::text::jsonb" : ""}`).join(", ")}, revision = revision + 1
            WHERE sequence = $1::bigint`,
          [sequence, ...recordValues(next, recordRow)],
        )
        if (changes) {
          if (changes.removed.length) {
            await transaction.unsafe(
              `DELETE FROM ${observationTable} WHERE invocation_sequence = $1::bigint AND position IN (SELECT jsonb_array_elements_text($2::text::jsonb)::bigint)`,
              [sequence, JSON.stringify(changes.removed)],
            )
          }
        }
        else if (rows.length) {
          await transaction.unsafe(`DELETE FROM ${observationTable} WHERE invocation_sequence = $1::bigint`, [sequence])
        }
        await insertObservations(transaction, sequence, ended ? [] : changes ? changes.added : updated.observations)
        if (ended) await prune(transaction, count)
        return updated
      })
    },
    async list(input = {}) {
      const listOptions = normalizeAgentInvocationListOptions(input, {
        sequenceCursor: true,
        diagnostics: {
          limit: agentDiagnostics.AGENT_R0919,
          searchType: agentDiagnostics.AGENT_R0619,
          searchLength: agentDiagnostics.AGENT_R0921,
          cursor: agentDiagnostics.AGENT_R0920,
        },
      })
      const statuses = listOptions.status === undefined ? [] : Array.isArray(listOptions.status) ? listOptions.status : [listOptions.status]
      if (Array.isArray(listOptions.status) && !statuses.length) return { invocations: [] }
      const filters: string[] = []
      const values: PostgresValue[] = []
      const parameter = (value: PostgresValue) => {
        values.push(value)
        return `$${values.length}`
      }
      if (listOptions.cursor !== undefined) filters.push(`sequence < ${parameter(listOptions.cursor)}::bigint`)
      if (statuses.length) filters.push(`status IN (${statuses.map(status => parameter(status)).join(", ")})`)
      if (typeof listOptions.updatedSince === "string") filters.push(`updated_at >= ${parameter(listOptions.updatedSince)}`)
      if (listOptions.agentName) filters.push(`agent_name = ${parameter(plainText(listOptions.agentName))}`)
      if (listOptions.capabilityId) filters.push(`capability_ids @> jsonb_build_array(${parameter(plainText(listOptions.capabilityId))}::text)`)
      if (listOptions.triggeredBy) filters.push(`btrim(triggered_by, ${parameter(sqlTrimWhitespace)}) = ${parameter(plainText(listOptions.triggeredBy))}`)
      if (listOptions.search) filters.push(`search LIKE ${parameter(`%${plainText(listOptions.search.toLowerCase()).replace(/[\\%_]/g, match => `\\${match}`)}%`)} ESCAPE '\\'`)
      const sql = await client()
      const rows = await sql.unsafe(
        `SELECT sequence::text AS sequence, summary FROM ${table}${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""} ORDER BY sequence DESC LIMIT ${parameter(listOptions.limit + 1)}`,
        values,
      )
      const invocations = rows.slice(0, listOptions.limit).map(row => parseSummary(row.summary, row.sequence))
      return { ...(rows.length > listOptions.limit ? { cursor: invocations.at(-1)!.cursor } : {}), invocations }
    },
    async listAgentNames() {
      const sql = await client()
      const rows = await sql.unsafe(`SELECT name FROM (SELECT DISTINCT agent_name AS name FROM ${table} WHERE agent_name <> '') names ORDER BY name COLLATE "C"`)
      return rows.flatMap(row => typeof row.name === "string" ? [row.name] : [])
    },
    async listCapabilityIds(agentName) {
      const sql = await client()
      const selectedAgent = agentName?.trim()
      const rows = await sql.unsafe(`SELECT capability_id FROM (SELECT DISTINCT capability.value AS capability_id
        FROM ${table}, jsonb_array_elements_text(capability_ids) AS capability(value)${selectedAgent ? " WHERE agent_name = $1" : ""}) ids
        ORDER BY capability_id COLLATE "C"`, selectedAgent ? [plainText(selectedAgent)] : [])
      return rows.flatMap(row => typeof row.capability_id === "string" ? [row.capability_id] : [])
    },
    async listTriggeredBy(agentName) {
      const sql = await client()
      const selectedAgent = agentName?.trim()
      const rows = await sql.unsafe(`SELECT triggered_by FROM (SELECT DISTINCT triggered_by FROM ${table}
        WHERE triggered_by IS NOT NULL AND btrim(triggered_by, $1) <> ''${selectedAgent ? " AND agent_name = $2" : ""}) labels
        ORDER BY triggered_by COLLATE "C"`, selectedAgent ? [sqlTrimWhitespace, plainText(selectedAgent)] : [sqlTrimWhitespace])
      return rows.flatMap(row => typeof row.triggered_by === "string" ? [row.triggered_by] : [])
    },
  }
}
