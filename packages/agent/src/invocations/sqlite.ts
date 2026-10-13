import { normalizeAgentInvocationListOptions } from "./list-options.ts"
import { createClient } from "@libsql/client"

import { hasRuntimeType } from "../internal/runtime-type.ts"
import { applyAgentInvocationStoreUpdate } from "../invocations.ts"
import { countRetentionDue } from "./retention.ts"
import { searchableAgentInvocationText } from "./search.ts"
import { filteredObservationRecord } from "./observation-projection.ts"
import { sqlTrimWhitespace } from "./sql-whitespace.ts"

import type {
  AgentInvocationListOptions,
  AgentInvocationListResult,
  AgentInvocationRecord,
  AgentInvocationRetentionOptions,
  AgentInvocationSummary,
  AgentInvocationStore,
  AgentInvocationStoreCreateInput,
  AgentInvocationStoreUpdateInput,
} from "../invocations.ts"
import type { Client, InStatement, Row } from "@libsql/client"
import type { TraceEventLogEntry } from "@vite-hub/runtime"
import { agentDiagnostics } from "../agent-diagnostics.ts"

export interface LibsqlAgentInvocationStoreOptions extends AgentInvocationRetentionOptions {
  authToken?: string
  client?: Client
  /** Maximum age of terminal invocation records. Defaults to 30 days. Set to false to disable age-based retention. */
  maxAgeMs?: false | number
  /** Maximum number of terminal invocation records. Defaults to 10,000. Set to false to disable count-based retention. Writes apply it on about 1 in `ceil(maxRecords / 100)` prunes, so the count can exceed it by about 1%. */
  maxRecords?: false | number
  tablePrefix?: string
  url?: string
}

const defaultMaxAgeMs = 30 * 24 * 60 * 60 * 1000
const defaultMaxRecords = 10_000
const maximumDateMs = 8_640_000_000_000_000
const backfillPageSize = 100
const observationInsertChunkSize = 200
const searchVersion = 3
const terminalStatuses = ["completed", "failed", "cancelled"] as const

function tableName(prefix = "vitehub_agent_"): string {
  const name = `${prefix}invocations`
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw agentDiagnostics.AGENT_R0628({ message: `[vitehub] Invalid SQLite Agent Invocation table name "${name}". Use an alphanumeric tablePrefix.` })
  }
  return name
}

function numberValue(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value)
}

function stringify(value: unknown): string {
  // A replacer runs for every value. Use it only when a BigInt makes plain serialization fail.
  try {
    return JSON.stringify(value)
  }
  catch {
    return JSON.stringify(value, (_key, item: unknown) => hasRuntimeType(item, "bigint") ? String(item) : item)
  }
}

function serialize(record: Omit<AgentInvocationRecord, "cursor">): string {
  return stringify(record)
}

function parsedObservation(value: unknown): TraceEventLogEntry | undefined {
  if (!hasRuntimeType(value, "string")) return
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || !hasRuntimeType(parsed, "object") || !("name" in parsed) || !hasRuntimeType(parsed.name, "string")) return
  // SAFETY: Observation rows are written from records that applyAgentInvocationStoreUpdate() produced.
  return parsed as TraceEventLogEntry
}

interface ObservationRow {
  observation: TraceEventLogEntry
  position: number
}

function observationRows(rows: readonly Row[]): ObservationRow[] {
  return rows.flatMap((row) => {
    const observation = parsedObservation(row.observation)
    return observation ? [{ observation, position: numberValue(row.position) }] : []
  })
}

function withObservationRows(record: AgentInvocationRecord, rows: readonly Row[]): AgentInvocationRecord {
  if (!rows.length) return record
  return { ...record, observations: [...record.observations, ...observationRows(rows).map(row => row.observation)] }
}

/**
 * Returns the row changes when an update kept the record's observations and the order of existing rows.
 * Appends and evictions of appended observations qualify. Any other change returns undefined.
 */
function observationRowChanges(
  inRecord: readonly TraceEventLogEntry[],
  rows: readonly ObservationRow[],
  observations: readonly TraceEventLogEntry[],
): { added: TraceEventLogEntry[], removed: number[] } | undefined {
  if (observations.length < inRecord.length || inRecord.some((observation, index) => observations[index] !== observation)) return
  const positions = new Map(rows.map(row => [row.observation, row.position]))
  const kept = new Set<number>()
  const added: TraceEventLogEntry[] = []
  let lastPosition = -1
  for (const observation of observations.slice(inRecord.length)) {
    const position = positions.get(observation)
    if (position === undefined) {
      added.push(observation)
      continue
    }
    if (added.length || position <= lastPosition) return
    lastPosition = position
    kept.add(position)
  }
  return { added, removed: rows.flatMap(row => kept.has(row.position) ? [] : [row.position]) }
}

function parsedRecord(value: unknown): Omit<AgentInvocationRecord, "cursor"> | undefined {
  if (typeof value !== "string") return
  const parsed: unknown = JSON.parse(value)
  if (
    parsed === null
    || typeof parsed !== "object"
    || !("id" in parsed)
    || typeof parsed.id !== "string"
    || !("status" in parsed)
    || (parsed.status !== "pending" && parsed.status !== "running" && parsed.status !== "completed" && parsed.status !== "failed" && parsed.status !== "cancelled")
    || !("traceId" in parsed)
    || typeof parsed.traceId !== "string"
    || !("createdAt" in parsed)
    || typeof parsed.createdAt !== "string"
    || !("updatedAt" in parsed)
    || typeof parsed.updatedAt !== "string"
  ) return
  // SAFETY: SQLite values are written by serialize(), and required invocation identity/lifecycle fields were validated.
  return parsed as Omit<AgentInvocationRecord, "cursor">
}

function deserialize(value: unknown, cursor: unknown): AgentInvocationRecord | undefined {
  const record = parsedRecord(value)
  if (!record || !("observations" in record) || !Array.isArray(record.observations)) return
  return { ...record, cursor: String(cursor) }
}

function deserializeSummary(value: unknown, cursor: unknown): AgentInvocationSummary | undefined {
  const record = parsedRecord(value)
  if (!record) return
  const { observations: _observations, ...summary } = record
  return { ...summary, cursor: String(cursor) }
}

function storedRecord(record: AgentInvocationRecord): Omit<AgentInvocationRecord, "cursor"> {
  const { cursor: _cursor, ...stored } = record
  return stored
}

function capabilityIdsProjection(table: string) {
  return `(SELECT json_group_array(capability_id) FROM (
    SELECT trim(capability.value) AS capability_id
      FROM json_each(CASE WHEN json_valid(record) THEN record ELSE '{}' END, '$.capabilityIds') AS capability
      WHERE typeof(capability.value) = 'text' AND trim(capability.value) <> ''
    UNION
    SELECT trim(json_extract(observation.value, '$."attributes"."capability.id"')) AS capability_id
      FROM json_each(CASE WHEN json_valid(record) THEN record ELSE '{}' END, '$.observations') AS observation
      WHERE json_type(observation.value, '$."attributes"."capability.id"') = 'text'
        AND trim(json_extract(observation.value, '$."attributes"."capability.id"')) <> ''
    UNION
    SELECT trim(json_extract(appended.observation, '$."attributes"."capability.id"')) AS capability_id
      FROM ${table}_observations AS appended
      WHERE appended.invocation_sequence = ${table}.sequence AND json_valid(appended.observation)
        AND json_type(appended.observation, '$."attributes"."capability.id"') = 'text'
        AND trim(json_extract(appended.observation, '$."attributes"."capability.id"')) <> ''
  ))`
}

// The index on this expression must use the same SQL text as the queries that read it.
function triggeredByProjection() {
  const source = "CASE WHEN json_valid(summary) THEN summary ELSE record END"
  return `CASE WHEN json_type(${source}, '$.annotations.triggeredBy') = 'text'
    THEN json_extract(${source}, '$.annotations.triggeredBy') END`
}

function serializedSummary(record: Omit<AgentInvocationRecord, "cursor">): string {
  const { observations: _observations, ...summary } = record
  return stringify(summary)
}

function agentNameRecord(record: Omit<AgentInvocationRecord, "cursor">): string {
  return record.agentName || ""
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

function retentionValue(value: false | number | undefined, fallback: number, name: string, maximum = Number.MAX_SAFE_INTEGER): false | number {
  if (value === false) return false
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw agentDiagnostics.AGENT_R0632({ message: `[vitehub] SQLite Agent Invocation ${name} must be a positive safe integer or false.` })
  }
  return value
}

function hasSqliteCode(error: unknown, code: string): boolean {
  let current = error
  while (current instanceof Error) {
    // SAFETY: libSQL errors extend Error with the conventional SQLite error code.
    if ((current as Error & { code?: unknown }).code === code) return true
    current = current.cause
  }
  return false
}

function isSqliteBusy(error: unknown): boolean {
  return hasSqliteCode(error, "SQLITE_BUSY")
}

async function retrySqliteBusy<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    }
    catch (error) {
      if (!isSqliteBusy(error) || attempt >= 12) throw error
      const maximumDelayMs = Math.min(100, 2 ** attempt)
      await new Promise(resolve => setTimeout(resolve, 1 + Math.floor(Math.random() * maximumDelayMs)))
    }
  }
}

interface PendingUpdate {
  input: AgentInvocationStoreUpdateInput
  reject: (error: unknown) => void
  resolve: (record: AgentInvocationRecord | undefined) => void
}

export function createLibsqlAgentInvocationStore(options: LibsqlAgentInvocationStoreOptions = {}): AgentInvocationStore {
  if (!options.client && !options.url) {
    throw agentDiagnostics.AGENT_R0633({ message: "[vitehub] SQLite Agent Invocations require url or client." })
  }
  const client = options.client || createClient({
    ...(options.authToken ? { authToken: options.authToken } : {}),
    url: options.url!,
  })
  const table = tableName(options.tablePrefix)
  const observationTable = `${table}_observations`
  const insertObservationRows = (sequence: number, observations: readonly TraceEventLogEntry[]): InStatement[] => {
    const statements: InStatement[] = []
    for (let start = 0; start < observations.length; start += observationInsertChunkSize) {
      const chunk = observations.slice(start, start + observationInsertChunkSize)
      statements.push({
        args: chunk.flatMap(observation => [sequence, stringify(observation)]),
        sql: `INSERT INTO ${observationTable} (invocation_sequence, observation) VALUES ${chunk.map(() => "(?, ?)").join(", ")}`,
      })
    }
    return statements
  }
  /** Reads the observation rows of one invocation in the order that they extend its record. */
  const observationRowsStatement = (id: string, observationNames?: string): InStatement => ({
    args: observationNames === undefined ? [id] : [id, observationNames],
    sql: `SELECT position, observation FROM ${observationTable}
      WHERE invocation_sequence = (SELECT sequence FROM ${table} WHERE id = ?)${observationNames === undefined
        ? ""
        : " AND json_extract(observation, '$.name') IN (SELECT value FROM json_each(?))"} ORDER BY position`,
  })
  const maxAgeMs = retentionValue(options.maxAgeMs, defaultMaxAgeMs, "maxAgeMs", maximumDateMs)
  const maxRecords = retentionValue(options.maxRecords, defaultMaxRecords, "maxRecords")
  let initialized: Promise<void> | undefined
  let synchronousNormal = false
  // synchronous is a per-connection setting, and libSQL opens pooled connections on demand.
  // Each write sets it on the idle connection that the write borrows next.
  const prepareWrite = async () => {
    if (synchronousNormal) await client.execute("PRAGMA synchronous = NORMAL")
  }
  let searchBackfill: Promise<void> | undefined
  let summaryBackfill: Promise<void> | undefined
  let writes = Promise.resolve()
  const write = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writes.then(operation, operation)
    writes = result.then(() => undefined, () => undefined)
    return result
  }
  // Keep invocation and claim identifiers separate. Concatenating them with a
  // delimiter allows distinct pairs to collide when either identifier contains
  // that delimiter.
  const pendingUpdates = new Map<string, Map<string | undefined, PendingUpdate[]>>()
  /** Applies queued updates to one record in one transaction. A failed update does not stop later ones. */
  const applyUpdateBatch = async (id: string, claimId: string | undefined, inputs: AgentInvocationStoreUpdateInput[]): Promise<Array<AgentInvocationRecord | Error | undefined>> => {
    await initialize()
    return await retrySqliteBusy(async () => {
      await prepareWrite()
      const transaction = await client.transaction("write")
      try {
        const result = await transaction.execute({
          args: claimId === undefined ? [id] : [id, id, claimId],
          sql: `SELECT sequence, search_version, record FROM ${table} WHERE id = ?${claimId === undefined
            ? ""
            : ` AND EXISTS (SELECT 1 FROM ${table}_claims WHERE id = ? AND claim_id = ?)`} LIMIT 1`,
        })
        const row = result.rows[0]
        const stored = row ? deserialize(row.record, row.sequence) : undefined
        if (!row || !stored) {
          await transaction.commit()
          return inputs.map(() => undefined)
        }
        const sequence = numberValue(row.sequence)
        const rows = observationRows((await transaction.execute({
          args: [sequence],
          sql: `SELECT position, observation FROM ${observationTable} WHERE invocation_sequence = ? ORDER BY position`,
        })).rows)
        const record = rows.length ? { ...stored, observations: [...stored.observations, ...rows.map(row => row.observation)] } : stored
        let updated = record
        const results = inputs.map((input) => {
          try {
            updated = applyAgentInvocationStoreUpdate(updated, input)
            return updated
          }
          catch (error) {
            return error instanceof Error ? error : new Error(String(error))
          }
        })
        if (updated === record) {
          await transaction.commit()
          return results
        }
        const next = storedRecord(updated)
        const terminal = updated.status === "completed" || updated.status === "failed" || updated.status === "cancelled"
        // SQLite rewrites the whole row for every UPDATE. A running record keeps appended observations
        // in their own rows, so an append writes one small row and a record row that does not grow.
        // A terminal record holds every observation in its record column, as readers of that column expect.
        // Changes other than appends and evictions of appended rows move every observation to rows once.
        const changes = terminal ? undefined : observationRowChanges(stored.observations, rows, updated.observations)
        const recordRow = { ...next, observations: terminal ? next.observations : changes ? stored.observations : [] }
        // Search text reads every observation. Running updates mark it stale; the next search
        // list and the terminal update rebuild it. Writing the current version again would fire the
        // stale-search trigger, so a terminal record that already has it is also marked stale.
        const freshSearch = terminal && numberValue(row.search_version) !== searchVersion
        await transaction.execute(freshSearch
          ? {
              args: [updated.status, agentNameRecord(next), searchableAgentInvocationText(next), searchVersion, serializedSummary(next), updated.updatedAt, serialize(recordRow), id],
              sql: `UPDATE ${table} SET status = ?, agent_name = ?, search = ?, search_version = ?, summary = ?, updated_at = ?, record = ?, capability_ids = NULL WHERE id = ?`,
            }
          : {
              args: [updated.status, agentNameRecord(next), serializedSummary(next), updated.updatedAt, serialize(recordRow), id],
              sql: `UPDATE ${table} SET status = ?, agent_name = ?, search_version = 0, summary = ?, updated_at = ?, record = ?, capability_ids = NULL WHERE id = ?`,
            })
        if (changes) {
          if (changes.removed.length) {
            await transaction.execute({
              args: [JSON.stringify(changes.removed)],
              sql: `DELETE FROM ${observationTable} WHERE position IN (SELECT value FROM json_each(?))`,
            })
          }
        }
        else if (rows.length) {
          await transaction.execute({ args: [sequence], sql: `DELETE FROM ${observationTable} WHERE invocation_sequence = ?` })
        }
        for (const statement of insertObservationRows(sequence, terminal ? [] : changes ? changes.added : updated.observations)) {
          await transaction.execute(statement)
        }
        if (terminal) {
          await prune(transaction)
        }
        await transaction.commit()
        return results
      }
      catch (error) {
        await transaction.rollback().catch(() => undefined)
        throw error
      }
      finally {
        await transaction.close()
      }
    })
  }
  const backfillSearch = async () => {
    while (true) {
      let backfillSequence = 0
      let projected = false
      while (true) {
        const missingSearch = await client.execute({
          args: [searchVersion, backfillSequence, backfillPageSize],
          sql: `SELECT sequence, record FROM ${table}
            WHERE (search IS NULL OR search_version < ?) AND sequence > ? ORDER BY sequence LIMIT ?`,
        })
        if (!missingSearch.rows.length) break
        const appended = await client.execute({
          args: [JSON.stringify(missingSearch.rows.map(row => numberValue(row.sequence)))],
          sql: `SELECT invocation_sequence, position, observation FROM ${observationTable}
            WHERE invocation_sequence IN (SELECT value FROM json_each(?)) ORDER BY position`,
        })
        const appendedRows = new Map<number, Row[]>()
        for (const row of appended.rows) {
          const sequence = numberValue(row.invocation_sequence)
          const group = appendedRows.get(sequence)
          if (group) group.push(row)
          else appendedRows.set(sequence, [row])
        }
        const searchUpdates = missingSearch.rows.flatMap((row) => {
          backfillSequence = Math.max(backfillSequence, numberValue(row.sequence))
          const rows = appendedRows.get(numberValue(row.sequence)) ?? []
          const stored = deserialize(row.record, row.sequence)
          const record = stored && withObservationRows(stored, rows)
          // An append can keep the record column unchanged, so the guard also compares the observation rows.
          // Positions are never reused, so the count and the last position identify the rows that were read.
          return record
            ? [{
                args: [
                  searchableAgentInvocationText(storedRecord(record)),
                  searchVersion,
                  numberValue(row.sequence),
                  searchVersion,
                  String(row.record),
                  numberValue(row.sequence),
                  `${rows.length}:${rows.length ? numberValue(rows.at(-1)!.position) : 0}`,
                ],
                sql: `UPDATE ${table} SET search = ?, search_version = ?
                  WHERE sequence = ? AND (search IS NULL OR search_version < ?) AND record = ?
                    AND (SELECT count(*) || ':' || COALESCE(max(position), 0) FROM ${observationTable} WHERE invocation_sequence = ?) = ?`,
              }]
            : []
        })
        if (searchUpdates.length) {
          await client.batch(searchUpdates, "write")
          projected = true
        }
      }
      // Revisit earlier rows, including guarded updates that lost a race and rows
      // invalidated by another writer after their page completed. Invalid records
      // are skipped without keeping the backfill alive.
      if (!projected) break
    }
  }
  const ensureSearchBackfill = () => {
    if (!searchBackfill) searchBackfill = backfillSearch().finally(() => {
      searchBackfill = undefined
    })
    return searchBackfill
  }
  const startSearchBackfill = () => {
    void ensureSearchBackfill().catch(() => undefined)
  }
  const backfillSummaries = async () => {
    let beforeSequence = Number.MAX_SAFE_INTEGER
    while (true) {
      const missingSummaries = await client.execute({
        args: [beforeSequence, backfillPageSize],
        sql: `SELECT sequence FROM ${table}
          WHERE summary IS NULL AND json_valid(record) AND sequence < ? ORDER BY sequence DESC LIMIT ?`,
      })
      if (!missingSummaries.rows.length) break
      beforeSequence = Math.min(...missingSummaries.rows.map(row => numberValue(row.sequence)))
      await client.batch(missingSummaries.rows.map(row => ({
        args: [numberValue(row.sequence)],
        sql: `UPDATE ${table} SET summary = json_remove(record, '$.observations')
          WHERE sequence = ? AND summary IS NULL AND json_valid(record)`,
      })), "write")
    }
  }
  const startSummaryBackfill = () => {
    if (summaryBackfill) return
    summaryBackfill = backfillSummaries().catch((error) => {
      summaryBackfill = undefined
      throw error
    })
    void summaryBackfill.catch(() => undefined)
  }
  const initialize = async () => {
    if (!initialized) initialized = (async () => {
      // libSQL reports "file" for local and in-memory databases. Remote libSQL and D1 manage their own journal.
      if (client.protocol === "file") {
        // WAL appends each commit instead of copying pages to a rollback journal, and readers do not block the writer.
        // NORMAL then syncs at checkpoints instead of at every commit: a power loss can drop the latest commits,
        // but the database stays consistent. A read-only file keeps its mode, so read-only inspection still works.
        const mode = await retrySqliteBusy(async () => await client.execute("PRAGMA journal_mode = WAL")).catch((error: unknown) => {
          if (hasSqliteCode(error, "SQLITE_READONLY")) return undefined
          throw error
        })
        synchronousNormal = mode?.rows[0]?.journal_mode === "wal"
      }
      await client.execute(`CREATE TABLE IF NOT EXISTS ${table} (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        agent_name TEXT NOT NULL DEFAULT '',
        search TEXT,
        search_version INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        capability_ids TEXT,
        updated_at TEXT NOT NULL DEFAULT '',
        record TEXT NOT NULL
      )`)
      const columns = await client.execute(`PRAGMA table_info(${table})`)
      if (!columns.rows.some(row => row.name === "search")) {
        try {
          await client.execute(`ALTER TABLE ${table} ADD COLUMN search TEXT`)
        }
        catch (error) {
          const currentColumns = await client.execute(`PRAGMA table_info(${table})`)
          if (!currentColumns.rows.some(row => row.name === "search")) throw error
        }
      }
      if (!columns.rows.some(row => row.name === "agent_name")) {
        try {
          await client.execute(`ALTER TABLE ${table} ADD COLUMN agent_name TEXT`)
        }
        catch (error) {
          const currentColumns = await client.execute(`PRAGMA table_info(${table})`)
          if (!currentColumns.rows.some(row => row.name === "agent_name")) throw error
        }
      }
      if (!columns.rows.some(row => row.name === "search_version")) {
        try {
          await client.execute(`ALTER TABLE ${table} ADD COLUMN search_version INTEGER NOT NULL DEFAULT 0`)
        }
        catch (error) {
          const currentColumns = await client.execute(`PRAGMA table_info(${table})`)
          if (!currentColumns.rows.some(row => row.name === "search_version")) throw error
        }
      }
      if (!columns.rows.some(row => row.name === "summary")) {
        try {
          await client.execute(`ALTER TABLE ${table} ADD COLUMN summary TEXT`)
        }
        catch (error) {
          const currentColumns = await client.execute(`PRAGMA table_info(${table})`)
          if (!currentColumns.rows.some(row => row.name === "summary")) throw error
        }
      }
      if (!columns.rows.some(row => row.name === "capability_ids")) {
        try {
          await client.execute(`ALTER TABLE ${table} ADD COLUMN capability_ids TEXT`)
        }
        catch (error) {
          const currentColumns = await client.execute(`PRAGMA table_info(${table})`)
          if (!currentColumns.rows.some(row => row.name === "capability_ids")) throw error
        }
      }
      // Updates clear capability_ids in the same statement. The trigger clears it only for
      // writers that change record alone, so it does not rewrite the row a second time.
      await client.execute(`CREATE TRIGGER IF NOT EXISTS ${table}_capability_ids_update_v2
        AFTER UPDATE OF record ON ${table}
        WHEN NEW.capability_ids IS NOT NULL
        BEGIN
          UPDATE ${table} SET capability_ids = NULL WHERE sequence = NEW.sequence;
        END`)
      await client.execute(`DROP TRIGGER IF EXISTS ${table}_capability_ids_update`)
      if (!columns.rows.some(row => row.name === "updated_at")) {
        try {
          await client.execute(`ALTER TABLE ${table} ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`)
        }
        catch (error) {
          const currentColumns = await client.execute(`PRAGMA table_info(${table})`)
          if (!currentColumns.rows.some(row => row.name === "updated_at")) throw error
        }
      }
      await client.execute(`CREATE TRIGGER IF NOT EXISTS ${table}_legacy_updated_at_insert
        AFTER INSERT ON ${table}
        WHEN NEW.updated_at = '' OR NEW.updated_at IS NULL
        BEGIN
          UPDATE ${table} SET updated_at = COALESCE(json_extract(NEW.record, '$.updatedAt'), '') WHERE sequence = NEW.sequence;
        END`)
      await client.execute(`CREATE TRIGGER IF NOT EXISTS ${table}_legacy_lifecycle_update_v2
        AFTER UPDATE OF record ON ${table}
        WHEN NEW.updated_at IS OLD.updated_at
        BEGIN
          UPDATE ${table} SET
            status = COALESCE(json_extract(NEW.record, '$.status'), NEW.status),
            updated_at = COALESCE(json_extract(NEW.record, '$.updatedAt'), '')
          WHERE sequence = NEW.sequence;
        END`)
      await client.execute(`DROP TRIGGER IF EXISTS ${table}_legacy_updated_at_update`)
      // Version 0 is already stale, so marking it stale again would only rewrite the row.
      await client.execute(`CREATE TRIGGER IF NOT EXISTS ${table}_stale_legacy_search_update_v2
        AFTER UPDATE OF search, record ON ${table}
        WHEN NEW.search_version = OLD.search_version AND NEW.search_version <> 0
        BEGIN
          UPDATE ${table} SET search_version = 0 WHERE sequence = NEW.sequence;
        END`)
      await client.execute(`DROP TRIGGER IF EXISTS ${table}_stale_legacy_search_update`)
      await client.execute(`CREATE TRIGGER IF NOT EXISTS ${table}_legacy_summary_insert
        AFTER INSERT ON ${table}
        WHEN NEW.summary IS NULL
        BEGIN
          UPDATE ${table} SET summary = CASE WHEN json_valid(NEW.record)
            THEN json_remove(NEW.record, '$.observations') END WHERE sequence = NEW.sequence;
        END`)
      await client.execute(`CREATE TRIGGER IF NOT EXISTS ${table}_legacy_summary_update
        AFTER UPDATE OF record ON ${table}
        WHEN NEW.summary IS OLD.summary
        BEGIN
          UPDATE ${table} SET summary = CASE WHEN json_valid(NEW.record)
            THEN json_remove(NEW.record, '$.observations') END WHERE sequence = NEW.sequence;
        END`)
      await client.execute(`CREATE INDEX IF NOT EXISTS ${table}_missing_updated_at_sequence
        ON ${table} (sequence) WHERE updated_at = '' OR updated_at IS NULL`)
      let backfillSequence = 0
      while (true) {
        const missingAgentNames = await client.execute({
          args: [backfillSequence, backfillPageSize],
          sql: `SELECT sequence, record FROM ${table} WHERE agent_name IS NULL AND sequence > ? ORDER BY sequence LIMIT ?`,
        })
        if (!missingAgentNames.rows.length) break
        const agentNameBackfill = missingAgentNames.rows.map((row) => {
          backfillSequence = Math.max(backfillSequence, numberValue(row.sequence))
          const record = deserialize(row.record, row.sequence)
          return {
            args: [record ? agentNameRecord(storedRecord(record)) : "", numberValue(row.sequence)],
            sql: `UPDATE ${table} SET agent_name = ? WHERE sequence = ? AND agent_name IS NULL`,
          }
        })
        await client.batch(agentNameBackfill, "write")
      }
      backfillSequence = 0
      while (true) {
        const missingUpdatedAt = await client.execute({
          args: [backfillSequence, backfillPageSize],
          sql: `SELECT sequence FROM ${table}
            WHERE (updated_at = '' OR updated_at IS NULL) AND sequence > ? ORDER BY sequence LIMIT ?`,
        })
        if (!missingUpdatedAt.rows.length) break
        const updatedAtBackfill = missingUpdatedAt.rows.map((row) => {
          backfillSequence = Math.max(backfillSequence, numberValue(row.sequence))
          return {
            args: [numberValue(row.sequence)],
            sql: `UPDATE ${table} SET
              status = COALESCE(json_extract(record, '$.status'), status),
              updated_at = COALESCE(json_extract(record, '$.updatedAt'), '')
              WHERE sequence = ? AND (updated_at = '' OR updated_at IS NULL)`,
          }
        })
        await client.batch(updatedAtBackfill, "write")
      }
      await client.execute(`CREATE INDEX IF NOT EXISTS ${table}_status_sequence ON ${table} (status, sequence DESC)`)
      await client.execute(`CREATE INDEX IF NOT EXISTS ${table}_status_updated_at ON ${table} (status, updated_at)`)
      await client.execute(`CREATE INDEX IF NOT EXISTS ${table}_agent_name_sequence ON ${table} (agent_name, sequence DESC)`)
      await client.execute(`CREATE INDEX IF NOT EXISTS ${table}_legacy_agent_name_sequence
        ON ${table} (json_extract(record, '$.agentName'), sequence DESC)
        WHERE agent_name IS NULL OR agent_name = ''`)
      // Tables from older versions store summary and capability_ids after the large record column.
      // Reading those values from the row walks every overflow page of record, so filter lists read them from these indexes.
      // Invocation list queries cannot use either index: one is partial, and the other starts with the label.
      await client.execute(`CREATE INDEX IF NOT EXISTS ${table}_agent_name_capability_ids
        ON ${table} (agent_name, capability_ids) WHERE capability_ids IS NOT NULL`)
      await client.execute(`CREATE INDEX IF NOT EXISTS ${table}_triggered_by_agent_name
        ON ${table} (${triggeredByProjection()}, agent_name)`)
      await client.execute(`CREATE TABLE IF NOT EXISTS ${table}_claims (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        claimed_at INTEGER NOT NULL DEFAULT 0,
        claim_token TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL
      )`)
      const claimColumns = await client.execute(`PRAGMA table_info(${table}_claims)`)
      if (!claimColumns.rows.some(row => row.name === "claimed_at")) {
        try {
          await client.execute(`ALTER TABLE ${table}_claims ADD COLUMN claimed_at INTEGER NOT NULL DEFAULT 0`)
        }
        catch (error) {
          const currentColumns = await client.execute(`PRAGMA table_info(${table}_claims)`)
          if (!currentColumns.rows.some(row => row.name === "claimed_at")) throw error
        }
        await client.execute(`UPDATE ${table}_claims
          SET claimed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE claimed_at = 0`)
      }
      if (!claimColumns.rows.some(row => row.name === "claim_token")) {
        try {
          await client.execute(`ALTER TABLE ${table}_claims ADD COLUMN claim_token TEXT NOT NULL DEFAULT ''`)
        }
        catch (error) {
          const currentColumns = await client.execute(`PRAGMA table_info(${table}_claims)`)
          if (!currentColumns.rows.some(row => row.name === "claim_token")) throw error
        }
      }
      await client.execute(`CREATE TRIGGER IF NOT EXISTS ${table}_refresh_legacy_claim
        AFTER UPDATE OF expires_at ON ${table}_claims
        WHEN NEW.claimed_at = OLD.claimed_at AND NEW.claim_token = OLD.claim_token
        BEGIN
          UPDATE ${table}_claims
          SET claimed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER), claim_token = lower(hex(randomblob(16)))
          WHERE id = NEW.id;
        END`)
      // Observations appended to a running Invocation. They follow the observations in its record column
      // in position order. The terminal update moves them back into the record column.
      // AUTOINCREMENT keeps positions unique over time, so a position identifies one row version.
      await client.execute(`CREATE TABLE IF NOT EXISTS ${observationTable} (
        position INTEGER PRIMARY KEY AUTOINCREMENT,
        invocation_sequence INTEGER NOT NULL,
        observation TEXT NOT NULL
      )`)
      await client.execute(`CREATE INDEX IF NOT EXISTS ${observationTable}_invocation
        ON ${observationTable} (invocation_sequence, position)`)
      // Deletes from any writer, including retention and older versions, remove the rows of the deleted Invocation.
      await client.execute(`CREATE TRIGGER IF NOT EXISTS ${observationTable}_delete
        AFTER DELETE ON ${table}
        BEGIN
          DELETE FROM ${observationTable} WHERE invocation_sequence = OLD.sequence;
        END`)
      startSearchBackfill()
      startSummaryBackfill()
    })().catch((error) => {
      initialized = undefined
      throw error
    })
    await initialized
  }
  const read: AgentInvocationStore["get"] = async (id, options) => {
    await initialize()
    const observationNames = options?.observationNames ? JSON.stringify(options.observationNames) : undefined
    // One read transaction keeps the record and its observation rows consistent with a concurrent terminal update.
    const [result, rows] = await client.batch([
      {
        args: observationNames === undefined ? [id] : [observationNames, id],
        sql: `SELECT sequence, ${observationNames === undefined ? "record" : filteredObservationRecord} AS record FROM ${table} WHERE id = ? LIMIT 1`,
      },
      observationRowsStatement(id, observationNames),
    ], "read")
    const row = result!.rows[0]
    const record = row ? deserialize(row.record, row.sequence) : undefined
    return record && withObservationRows(record, rows!.rows)
  }
  const readSummary = async (id: string): Promise<AgentInvocationSummary | undefined> => {
    await initialize()
    startSummaryBackfill()
    const result = await client.execute({
      args: [id],
      sql: `SELECT sequence, COALESCE(summary, CASE WHEN json_valid(record)
        THEN json_remove(record, '$.observations') END) AS summary FROM ${table} WHERE id = ? LIMIT 1`,
    })
    const row = result.rows[0]
    return row ? deserializeSummary(row.summary, row.sequence) : undefined
  }
  const terminalPlaceholders = terminalStatuses.map(() => "?").join(", ")
  // Each selection uses one index. An OR across updated_at and sequence makes SQLite read every terminal row.
  const ageSelection = (updatedBefore: string) => ({
    args: [...terminalStatuses, updatedBefore],
    where: `status IN (${terminalPlaceholders}) AND updated_at < ?`,
  })
  // Merge the three ordered status-index scans, stopping at maxRecords without reading active rows.
  const countSelection = (limit: number) => ({
    args: [...terminalStatuses, ...terminalStatuses, limit - 1],
    where: `status IN (${terminalPlaceholders}) AND sequence < (
      ${terminalStatuses.map(() => `SELECT sequence FROM ${table} WHERE status = ?`).join(" UNION ALL ")}
      ORDER BY sequence DESC LIMIT 1 OFFSET ?
    )`,
  })
  // Selects terminal records by an explicit cutoff, or by configured retention when no cutoff is given.
  // The count limit runs first, so both limits select from the same terminal records.
  const pruneSelections = (count: boolean, updatedBefore?: string, now = Date.now()) => {
    if (updatedBefore !== undefined) return [ageSelection(updatedBefore)]
    return [
      ...(count && maxRecords !== false ? [countSelection(maxRecords)] : []),
      ...(maxAgeMs !== false ? [ageSelection(new Date(now - maxAgeMs).toISOString())] : []),
    ]
  }
  const deleteOrphanClaims = `DELETE FROM ${table}_claims
      WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${table}.id = ${table}_claims.id)`
  const pruneStatements = (count: boolean, now = Date.now()) => {
    const selections = pruneSelections(count, undefined, now)
    if (!selections.length) return []
    return [...selections.map(selection => ({ args: selection.args, sql: `DELETE FROM ${table} WHERE ${selection.where}` })), deleteOrphanClaims]
  }
  const prune = async (executor: Pick<Client, "execute">) => {
    for (const statement of pruneStatements(countRetentionDue(maxRecords))) await executor.execute(statement)
  }
  return {
    async claim(id, claimId, leaseMs, options) {
      return write(async () => {
        await initialize()
        await prepareWrite()
        const claimToken = globalThis.crypto.randomUUID()
        const expectedClaimIds = options?.expectedClaimIds === undefined ? null : JSON.stringify(options.expectedClaimIds)
        const result = await client.execute({
          args: [id, claimId, claimToken, leaseMs, id, expectedClaimIds, expectedClaimIds, expectedClaimIds, options?.replaceExisting ? 1 : 0, options?.replaceClaimToken ?? null, options?.replaceClaimToken ?? null],
          sql: `INSERT INTO ${table}_claims (id, claim_id, claim_token, claimed_at, expires_at)
            SELECT ?, ?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER) + ? WHERE EXISTS (SELECT 1 FROM ${table} WHERE id = ?)
            ON CONFLICT(id) DO UPDATE SET claim_id = excluded.claim_id, claim_token = excluded.claim_token, claimed_at = excluded.claimed_at, expires_at = excluded.expires_at
            WHERE (? IS NOT NULL AND ${table}_claims.claim_id IN (SELECT value FROM json_each(?)))
              OR (? IS NULL AND (? = 1 OR (? IS NOT NULL AND ${table}_claims.claim_token = ?) OR ${table}_claims.claim_id = excluded.claim_id
                OR ${table}_claims.expires_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)))`,
        })
        return result.rowsAffected > 0
      })
    },
    async create(input: AgentInvocationStoreCreateInput) {
      return write(async () => {
        await initialize()
        return await retrySqliteBusy(async () => {
          await prepareWrite()
          const retentionNow = Date.now()
          const count = countRetentionDue(maxRecords)
          const prePrune = pruneStatements(count, retentionNow)
          const insertIndex = prePrune.length
          const statements: InStatement[] = [
            ...prePrune,
            {
              args: [input.id, input.status, agentNameRecord(input), searchableAgentInvocationText(input), searchVersion, serializedSummary(input), input.updatedAt, serialize(input)],
              sql: `INSERT OR IGNORE INTO ${table} (id, status, agent_name, search, search_version, summary, updated_at, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            }
          ]
          if (input.status === "completed" || input.status === "failed" || input.status === "cancelled") {
            statements.push(...pruneStatements(count, retentionNow))
          }
          statements.push({
            args: [input.id],
            sql: `SELECT sequence, record FROM ${table} WHERE id = ? LIMIT 1`,
          }, observationRowsStatement(input.id))
          const results = await client.batch(statements, "write")
          const row = results.at(-2)?.rows[0]
          const stored = row ? deserialize(row.record, row.sequence) : undefined
          const record = stored && withObservationRows(stored, results.at(-1)?.rows ?? [])
          if (!record) throw agentDiagnostics.AGENT_R0634({ message: `[vitehub] SQLite Agent Invocation ${JSON.stringify(input.id)} was removed by retention.` })
          return { created: results[insertIndex]!.rowsAffected > 0, record }
        })
      })
    },
    async getClaimToken(id) {
      await initialize()
      const result = await client.execute({
        args: [id],
        sql: `SELECT claim_token FROM ${table}_claims WHERE id = ?`,
      })
      const claimToken = result.rows[0]?.claim_token
      return hasRuntimeType(claimToken, "string") ? claimToken : undefined
    },
    get: read,
    getSummary: readSummary,
    async list(input: AgentInvocationListOptions = {}): Promise<AgentInvocationListResult> {
      await initialize()
      startSummaryBackfill()
      const listOptions = normalizeAgentInvocationListOptions(input, {
        sequenceCursor: true,
        diagnostics: {
          limit: agentDiagnostics.AGENT_R0629,
          searchType: agentDiagnostics.AGENT_R0630,
          searchLength: agentDiagnostics.AGENT_R0631,
          cursor: agentDiagnostics.AGENT_R0635,
        },
      })
      const { limit, search } = listOptions
      const statuses = listOptions.status === undefined
        ? []
        : Array.isArray(listOptions.status) ? listOptions.status : [listOptions.status]
      if (Array.isArray(listOptions.status) && listOptions.status.length === 0) return { invocations: [] }
      const before = listOptions.cursor === undefined ? undefined : numberValue(listOptions.cursor)
      const filters: string[] = []
      const args: Array<number | string> = []
      if (before !== undefined) {
        filters.push("sequence < ?")
        args.push(before)
      }
      if (statuses.length) {
        filters.push(`status IN (${statuses.map(() => "?").join(", ")})`)
        args.push(...statuses)
      }
      const agentName = listOptions.agentName?.trim()
      if (agentName) {
        filters.push("(agent_name = ? OR ((agent_name IS NULL OR agent_name = '') AND json_extract(record, '$.agentName') = ?))")
        args.push(agentName, agentName)
      }
      const capabilityId = listOptions.capabilityId?.trim()
      if (capabilityId) {
        filters.push(`(EXISTS (SELECT 1
          FROM json_each(CASE WHEN json_valid(record) THEN record ELSE '{}' END, '$.capabilityIds') AS capability
          WHERE capability.value = ?)
          OR EXISTS (SELECT 1
          FROM json_each(CASE WHEN json_valid(record) THEN record ELSE '{}' END, '$.observations') AS observation
          WHERE json_extract(observation.value, '$."attributes"."capability.id"') = ?)
          OR EXISTS (SELECT 1 FROM ${observationTable} AS appended
          WHERE appended.invocation_sequence = ${table}.sequence AND json_valid(appended.observation)
            AND json_extract(appended.observation, '$."attributes"."capability.id"') = ?))`)
        args.push(capabilityId, capabilityId, capabilityId)
      }
      const triggeredBy = listOptions.triggeredBy?.trim()
      if (triggeredBy) {
        filters.push("json_type(CASE WHEN json_valid(summary) THEN summary ELSE record END, '$.annotations.triggeredBy') = 'text' AND trim(json_extract(CASE WHEN json_valid(summary) THEN summary ELSE record END, '$.annotations.triggeredBy'), ?) = ?")
        args.push(sqlTrimWhitespace, triggeredBy)
      }
      if (search) {
        await ensureSearchBackfill()
        filters.push("search LIKE ? ESCAPE '\\'")
        args.push(`%${escapeLike(search.toLowerCase())}%`)
      }
      args.push(limit + 1)
      const result = await client.execute({
        args,
        sql: `SELECT sequence, COALESCE(summary, CASE WHEN json_valid(record)
          THEN json_remove(record, '$.observations') END) AS summary
          FROM ${table}${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""} ORDER BY sequence DESC LIMIT ?`,
      })
      const records = result.rows
        .map(row => deserializeSummary(row.summary, row.sequence))
        .filter((record): record is AgentInvocationSummary => Boolean(record))
      const page = records.slice(0, limit)
      return {
        ...(records.length > limit && page.length ? { cursor: page.at(-1)!.cursor } : {}),
        invocations: page,
      }
    },
    async listAgentNames() {
      await initialize()
      const result = await client.execute(`SELECT DISTINCT name FROM (
        SELECT agent_name AS name FROM ${table} WHERE agent_name <> ''
        UNION ALL
        SELECT json_extract(record, '$.agentName') AS name FROM ${table}
          WHERE agent_name IS NULL OR agent_name = ''
      ) WHERE typeof(name) = 'text' AND name <> '' ORDER BY name`)
      return result.rows.flatMap((row) => {
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- LibSQL rows are external storage values, so validate the indexed Agent name before exposing it.
        return typeof row.name === "string" ? [row.name] : []
      })
    },
    async listCapabilityIds(agentName) {
      await initialize()
      const selectedAgent = agentName?.trim()
      const args: string[] = []
      if (selectedAgent) {
        args.push(selectedAgent, selectedAgent)
      }
      const filter = selectedAgent
        ? "(agent_name = ? OR ((agent_name IS NULL OR agent_name = '') AND json_extract(record, '$.agentName') = ?))"
        : "1 = 1"
      // Cache complete IDs only when requested. Record writes invalidate the projection,
      // including writes from older clients that do not know about this column.
      await write(async () => await retrySqliteBusy(async () => await client.execute({
        args,
        sql: `UPDATE ${table} SET capability_ids = ${capabilityIdsProjection(table)}
          WHERE capability_ids IS NULL AND ${filter}`,
      })))
      // A writer can invalidate the cache between these statements. Resolve those rows
      // from their current record so an active Invocation never returns stale IDs.
      // Cached IDs come from the covering index. Only legacy rows without agent_name read the row.
      const rows = selectedAgent
        ? `SELECT capability_ids AS ids FROM ${table} WHERE agent_name = ? AND capability_ids IS NOT NULL
          UNION ALL SELECT ${capabilityIdsProjection(table)} FROM ${table} WHERE agent_name = ? AND capability_ids IS NULL
          UNION ALL SELECT COALESCE(capability_ids, ${capabilityIdsProjection(table)}) FROM ${table}
            WHERE (agent_name IS NULL OR agent_name = '') AND json_extract(record, '$.agentName') = ?`
        : `SELECT capability_ids AS ids FROM ${table} WHERE capability_ids IS NOT NULL
          UNION ALL SELECT ${capabilityIdsProjection(table)} FROM ${table} WHERE capability_ids IS NULL`
      const result = await client.execute({
        args: selectedAgent ? [selectedAgent, selectedAgent, selectedAgent] : [],
        sql: `SELECT DISTINCT capability.value AS capability_id
          FROM (${rows}) AS invocation, json_each(invocation.ids) AS capability ORDER BY capability_id`,
      })
      return result.rows.flatMap((row) => {
        return hasRuntimeType(row.capability_id, "string") ? [row.capability_id] : []
      })
    },
    async listTriggeredBy(agentName) {
      await initialize()
      const selectedAgent = agentName?.trim()
      const triggeredBy = triggeredByProjection()
      // The planner prefers agent_name_sequence for the Agent filter, which evaluates the label from every row.
      // INDEXED BY reads the label from the expression index instead. Only legacy rows without agent_name read the row.
      const labels = `SELECT ${triggeredBy} AS triggered_by FROM ${table} INDEXED BY ${table}_triggered_by_agent_name
        WHERE ${triggeredBy} IS NOT NULL`
      const rows = selectedAgent
        ? `${labels} AND agent_name = ?
          UNION ALL SELECT ${triggeredBy} FROM ${table}
            WHERE (agent_name IS NULL OR agent_name = '') AND json_extract(record, '$.agentName') = ?`
        : labels
      const result = await client.execute({
        args: selectedAgent ? [selectedAgent, selectedAgent] : [],
        sql: `SELECT DISTINCT triggered_by FROM (${rows}) WHERE trim(triggered_by) <> '' ORDER BY triggered_by`,
      })
      return result.rows.flatMap(row => hasRuntimeType(row.triggered_by, "string") ? [row.triggered_by] : [])
    },
    async delete(id) {
      return write(async () => {
        await initialize()
        return await retrySqliteBusy(async () => {
          await prepareWrite()
          const terminalPlaceholders = terminalStatuses.map(() => "?").join(", ")
          const results = await client.batch([
            { args: [id, ...terminalStatuses], sql: `DELETE FROM ${table} WHERE id = ? AND status IN (${terminalPlaceholders})` },
            { args: [id, id], sql: `DELETE FROM ${table}_claims WHERE id = ? AND NOT EXISTS (SELECT 1 FROM ${table} WHERE id = ?)` },
            { args: [id], sql: `SELECT 1 FROM ${table} WHERE id = ? LIMIT 1` },
          ], "write")
          if (results[0]!.rowsAffected > 0) return "deleted"
          return results[2]!.rows.length ? "not-terminal" : "not-found"
        })
      })
    },
    async prune(pruneOptions) {
      const dryRun = pruneOptions.dryRun === true
      return write(async () => {
        await initialize()
        return await retrySqliteBusy(async () => {
          const selections = pruneSelections(true, pruneOptions.updatedBefore)
          if (!selections.length) return { dryRun, ids: [] }
          const results = await client.batch(dryRun
            ? [{
                args: selections.flatMap<number | string>(selection => selection.args),
                sql: `${selections.map(selection => `SELECT id, sequence FROM ${table} WHERE ${selection.where}`).join(" UNION ")} ORDER BY sequence`,
              }]
            : [
                ...selections.map(selection => ({ args: selection.args, sql: `DELETE FROM ${table} WHERE ${selection.where} RETURNING id` })),
                deleteOrphanClaims,
              ], "write")
          const ids = results.slice(0, selections.length).flatMap(result => result.rows.flatMap(row => hasRuntimeType(row.id, "string") ? [row.id] : []))
          return { dryRun, ids }
        })
      })
    },
    async release(id, claimId) {
      await write(async () => {
        await initialize()
        await prepareWrite()
        await client.execute({
          args: [id, claimId],
          sql: `DELETE FROM ${table}_claims WHERE id = ? AND claim_id = ?`,
        })
      })
    },
    async update(id, input, claimId) {
      // Updates for one invocation that wait behind another write share one
      // read, serialization, and commit. Each update still applies in order.
      let updatesByClaim = pendingUpdates.get(id)
      if (!updatesByClaim) {
        updatesByClaim = new Map()
        pendingUpdates.set(id, updatesByClaim)
      }
      let batch = updatesByClaim.get(claimId)
      if (!batch) {
        const items: PendingUpdate[] = []
        batch = items
        updatesByClaim.set(claimId, items)
        void write(async () => {
          if (updatesByClaim?.get(claimId) === items) updatesByClaim.delete(claimId)
          if (updatesByClaim?.size === 0 && pendingUpdates.get(id) === updatesByClaim) pendingUpdates.delete(id)
          try {
            const results = await applyUpdateBatch(id, claimId, items.map(item => item.input))
            items.forEach((item, index) => {
              const result = results[index]
              if (result instanceof Error) item.reject(result)
              else item.resolve(result)
            })
          }
          catch (error) {
            for (const item of items) item.reject(error)
          }
        })
      }
      const items = batch
      return await new Promise<AgentInvocationRecord | undefined>((resolve, reject) => {
        items.push({ input, reject, resolve })
      })
    },
  }
}
