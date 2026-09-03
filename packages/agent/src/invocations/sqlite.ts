import { createClient } from "@libsql/client"

import { hasRuntimeType } from "../internal/runtime-type.ts"
import { applyAgentInvocationStoreUpdate } from "../invocations.ts"
import { searchableAgentInvocationText } from "./search.ts"

import type {
  AgentInvocationListOptions,
  AgentInvocationListResult,
  AgentInvocationRecord,
  AgentInvocationSummary,
  AgentInvocationStore,
  AgentInvocationStoreCreateInput,
} from "../invocations.ts"
import type { Client } from "@libsql/client"

export interface LibsqlAgentInvocationStoreOptions {
  authToken?: string
  client?: Client
  /** Maximum age of terminal invocation records. Defaults to 30 days. Set to false to disable age-based retention. */
  maxAgeMs?: false | number
  /** Maximum number of terminal invocation records. Defaults to 10,000. Set to false to disable count-based retention. */
  maxRecords?: false | number
  tablePrefix?: string
  url?: string
}

const defaultMaxAgeMs = 30 * 24 * 60 * 60 * 1000
const defaultMaxRecords = 10_000
const maximumDateMs = 8_640_000_000_000_000
const backfillPageSize = 100
const searchVersion = 3
const terminalStatuses = ["completed", "failed", "cancelled"] as const

function tableName(prefix = "vitehub_agent_"): string {
  const name = `${prefix}invocations`
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`[vitehub] Invalid SQLite Agent Invocation table name "${name}". Use an alphanumeric tablePrefix.`)
  }
  return name
}

function numberValue(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value)
}

function serialize(record: Omit<AgentInvocationRecord, "cursor">): string {
  return JSON.stringify(record, (_key, value) => typeof value === "bigint" ? String(value) : value)
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

function serializedSummary(record: Omit<AgentInvocationRecord, "cursor">): string {
  const { observations: _observations, ...summary } = record
  return JSON.stringify(summary, (_key, value) => typeof value === "bigint" ? String(value) : value)
}

function agentNameRecord(record: Omit<AgentInvocationRecord, "cursor">): string {
  return record.agentName || ""
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

function listLimit(limit: number | undefined): number {
  if (limit === undefined) return 50
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError("[vitehub] Agent Invocation list limit must be a positive integer.")
  }
  return Math.min(limit, 100)
}

function searchValue(search: string | undefined): string | undefined {
  if (search === undefined) return
  if (typeof search !== "string") throw new TypeError("[vitehub] Agent Invocation search must be a string.")
  const value = search.trim()
  if (value.length > 256) throw new TypeError("[vitehub] Agent Invocation search must be at most 256 characters.")
  return value || undefined
}

function retentionValue(value: false | number | undefined, fallback: number, name: string, maximum = Number.MAX_SAFE_INTEGER): false | number {
  if (value === false) return false
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`[vitehub] SQLite Agent Invocation ${name} must be a positive safe integer or false.`)
  }
  return value
}

function isSqliteBusy(error: unknown): boolean {
  let current = error
  while (current instanceof Error) {
    // SAFETY: libSQL errors extend Error with the conventional SQLite error code.
    if ((current as Error & { code?: unknown }).code === "SQLITE_BUSY") return true
    current = current.cause
  }
  return false
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

export function createLibsqlAgentInvocationStore(options: LibsqlAgentInvocationStoreOptions = {}): AgentInvocationStore {
  if (!options.client && !options.url) {
    throw new TypeError("[vitehub] SQLite Agent Invocations require url or client.")
  }
  const client = options.client || createClient({
    ...(options.authToken ? { authToken: options.authToken } : {}),
    url: options.url!,
  })
  const table = tableName(options.tablePrefix)
  const maxAgeMs = retentionValue(options.maxAgeMs, defaultMaxAgeMs, "maxAgeMs", maximumDateMs)
  const maxRecords = retentionValue(options.maxRecords, defaultMaxRecords, "maxRecords")
  let initialized: Promise<void> | undefined
  let searchBackfill: Promise<void> | undefined
  let summaryBackfill: Promise<void> | undefined
  let writes = Promise.resolve()
  const write = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writes.then(operation, operation)
    writes = result.then(() => undefined, () => undefined)
    return result
  }
  const backfillSearch = async () => {
    let backfillSequence = 0
    while (true) {
      const missingSearch = await client.execute({
        args: [searchVersion, backfillSequence, backfillPageSize],
        sql: `SELECT sequence, record FROM ${table}
          WHERE (search IS NULL OR search_version < ?) AND sequence > ? ORDER BY sequence LIMIT ?`,
      })
      if (!missingSearch.rows.length) break
      const searchUpdates = missingSearch.rows.flatMap((row) => {
        backfillSequence = Math.max(backfillSequence, numberValue(row.sequence))
          const record = deserialize(row.record, row.sequence)
          return record
            ? [{
                args: [
                  searchableAgentInvocationText(storedRecord(record)),
                  searchVersion,
                  numberValue(row.sequence),
                  searchVersion,
                  String(row.record),
                ],
                sql: `UPDATE ${table} SET search = ?, search_version = ?
                  WHERE sequence = ? AND search_version < ? AND record = ?`,
              }]
            : []
      })
      if (searchUpdates.length) await client.batch(searchUpdates, "write")
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
      await client.execute(`CREATE TABLE IF NOT EXISTS ${table} (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        agent_name TEXT NOT NULL DEFAULT '',
        search TEXT,
        search_version INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
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
      await client.execute(`CREATE TRIGGER IF NOT EXISTS ${table}_stale_legacy_search_update
        AFTER UPDATE OF search, record ON ${table}
        WHEN NEW.search_version = OLD.search_version
        BEGIN
          UPDATE ${table} SET search_version = 0 WHERE sequence = NEW.sequence;
        END`)
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
      startSearchBackfill()
      startSummaryBackfill()
    })().catch((error) => {
      initialized = undefined
      throw error
    })
    await initialized
  }
  const read = async (id: string): Promise<AgentInvocationRecord | undefined> => {
    await initialize()
    const result = await client.execute({
      args: [id],
      sql: `SELECT sequence, record FROM ${table} WHERE id = ? LIMIT 1`,
    })
    const row = result.rows[0]
    return row ? deserialize(row.record, row.sequence) : undefined
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
  const pruneStatements = (now = Date.now()) => {
    const filters: string[] = []
    const args: Array<number | string> = []
    const terminalPlaceholders = terminalStatuses.map(() => "?").join(", ")
    if (maxAgeMs !== false) {
      filters.push("updated_at < ?")
      args.push(new Date(now - maxAgeMs).toISOString())
    }
    if (maxRecords !== false) {
      filters.push(`sequence NOT IN (
        SELECT sequence FROM ${table} WHERE status IN (${terminalPlaceholders}) ORDER BY sequence DESC LIMIT ?
      )`)
      args.push(...terminalStatuses, maxRecords)
    }
    if (!filters.length) return []
    const deleteInvocations = {
      args: [...terminalStatuses, ...args],
      sql: `DELETE FROM ${table} WHERE status IN (${terminalPlaceholders}) AND (${filters.join(" OR ")})`,
    }
    const deleteClaims = `DELETE FROM ${table}_claims
      WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${table}.id = ${table}_claims.id)`
    return [deleteInvocations, deleteClaims]
  }
  const prune = async (executor?: Pick<Client, "execute">) => {
    const statements = pruneStatements()
    if (!statements.length) return
    if (executor) {
      for (const statement of statements) await executor.execute(statement)
      return
    }
    await client.batch(statements, "write")
  }
  return {
    async claim(id, claimId, leaseMs, options) {
      return write(async () => {
        await initialize()
        const claimToken = globalThis.crypto.randomUUID()
        const result = await client.execute({
          args: [id, claimId, claimToken, leaseMs, id, options?.replaceExisting ? 1 : 0, options?.replaceClaimToken ?? null, options?.replaceClaimToken ?? null],
          sql: `INSERT INTO ${table}_claims (id, claim_id, claim_token, claimed_at, expires_at)
            SELECT ?, ?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER) + ? WHERE EXISTS (SELECT 1 FROM ${table} WHERE id = ?)
            ON CONFLICT(id) DO UPDATE SET claim_id = excluded.claim_id, claim_token = excluded.claim_token, claimed_at = excluded.claimed_at, expires_at = excluded.expires_at
            WHERE ? = 1 OR (? IS NOT NULL AND ${table}_claims.claim_token = ?) OR ${table}_claims.claim_id = excluded.claim_id
              OR ${table}_claims.expires_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)`,
        })
        return result.rowsAffected > 0
      })
    },
    async create(input: AgentInvocationStoreCreateInput) {
      return write(async () => {
        await initialize()
        return await retrySqliteBusy(async () => {
          const retentionNow = Date.now()
          const prePrune = pruneStatements(retentionNow)
          const insertIndex = prePrune.length
          const statements = [
            ...prePrune,
            {
              args: [input.id, input.status, agentNameRecord(input), searchableAgentInvocationText(input), searchVersion, serializedSummary(input), input.updatedAt, serialize(input)],
              sql: `INSERT OR IGNORE INTO ${table} (id, status, agent_name, search, search_version, summary, updated_at, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            }
          ]
          if (input.status === "completed" || input.status === "failed" || input.status === "cancelled") {
            statements.push(...pruneStatements(retentionNow))
          }
          statements.push({
            args: [input.id],
            sql: `SELECT sequence, record FROM ${table} WHERE id = ? LIMIT 1`,
          })
          const results = await client.batch(statements, "write")
          const row = results.at(-1)?.rows[0]
          const record = row ? deserialize(row.record, row.sequence) : undefined
          if (!record) throw new Error(`[vitehub] SQLite Agent Invocation ${JSON.stringify(input.id)} was removed by retention.`)
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
    async list(listOptions: AgentInvocationListOptions = {}): Promise<AgentInvocationListResult> {
      await initialize()
      startSummaryBackfill()
      const limit = listLimit(listOptions.limit)
      const statuses = listOptions.status === undefined
        ? []
        : Array.isArray(listOptions.status) ? listOptions.status : [listOptions.status]
      if (Array.isArray(listOptions.status) && listOptions.status.length === 0) return { invocations: [] }
      const before = listOptions.cursor === undefined ? undefined : numberValue(listOptions.cursor)
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1 || String(before) !== listOptions.cursor)) {
        throw new TypeError("[vitehub] Agent Invocation cursor is invalid.")
      }
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
          WHERE json_extract(observation.value, '$."attributes"."capability.id"') = ?))`)
        args.push(capabilityId, capabilityId)
      }
      const search = searchValue(listOptions.search)
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
      const result = await client.execute({
        args,
        sql: `SELECT DISTINCT capability_id FROM (
          SELECT trim(capability.value) AS capability_id, agent_name, record
            FROM ${table}, json_each(CASE WHEN json_valid(record) THEN record ELSE '{}' END, '$.capabilityIds') AS capability
            WHERE typeof(capability.value) = 'text' AND trim(capability.value) <> ''
          UNION ALL
          SELECT trim(json_extract(observation.value, '$."attributes"."capability.id"')) AS capability_id, agent_name, record
            FROM ${table}, json_each(CASE WHEN json_valid(record) THEN record ELSE '{}' END, '$.observations') AS observation
            WHERE json_type(observation.value, '$."attributes"."capability.id"') = 'text'
              AND trim(json_extract(observation.value, '$."attributes"."capability.id"')) <> ''
        ) WHERE ${selectedAgent
          ? "(agent_name = ? OR ((agent_name IS NULL OR agent_name = '') AND json_extract(record, '$.agentName') = ?))"
          : "1 = 1"} ORDER BY capability_id`,
      })
      return result.rows.flatMap((row) => {
        return hasRuntimeType(row.capability_id, "string") ? [row.capability_id] : []
      })
    },
    async release(id, claimId) {
      await write(async () => {
        await initialize()
        await client.execute({
          args: [id, claimId],
          sql: `DELETE FROM ${table}_claims WHERE id = ? AND claim_id = ?`,
        })
      })
    },
    async update(id, input, claimId) {
      return write(async () => {
        await initialize()
        return await retrySqliteBusy(async () => {
          const transaction = await client.transaction("write")
          try {
            const result = await transaction.execute({
              args: claimId ? [id, id, claimId] : [id],
              sql: `SELECT sequence, record FROM ${table} WHERE id = ?${claimId
                ? ` AND EXISTS (SELECT 1 FROM ${table}_claims WHERE id = ? AND claim_id = ?)`
                : ""} LIMIT 1`,
            })
            const row = result.rows[0]
            const record = row ? deserialize(row.record, row.sequence) : undefined
            if (!record) {
              await transaction.commit()
              return
            }
            const updated = applyAgentInvocationStoreUpdate(record, input)
            const stored = storedRecord(updated)
            await transaction.execute({
              args: [id],
              sql: `UPDATE ${table} SET search_version = -1, summary = NULL WHERE id = ?`,
            })
            await transaction.execute({
              args: [updated.status, agentNameRecord(stored), searchableAgentInvocationText(stored), searchVersion, serializedSummary(stored), updated.updatedAt, serialize(stored), id],
              sql: `UPDATE ${table} SET status = ?, agent_name = ?, search = ?, search_version = ?, summary = ?, updated_at = ?, record = ? WHERE id = ?`,
            })
            if (updated.status === "completed" || updated.status === "failed" || updated.status === "cancelled") {
              await prune(transaction)
            }
            await transaction.commit()
            return updated
          }
          catch (error) {
            await transaction.rollback().catch(() => undefined)
            throw error
          }
          finally {
            await transaction.close()
          }
        })
      })
    },
  }
}
