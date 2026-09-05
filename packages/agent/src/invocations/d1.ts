import { applyAgentInvocationStoreUpdate, byteBoundedObservations, isAppendedObservation, observationLimits } from "../invocations.ts"
import { searchableAgentInvocationText } from "./search.ts"

import type { AgentInvocationRecord, AgentInvocationStore, AgentInvocationStoreCreateInput, AgentInvocationSummary } from "../invocations.ts"

/** The D1 operations used by the journal. A Cloudflare D1Database satisfies this contract. */
export interface AgentInvocationD1Database {
  prepare(query: string): AgentInvocationD1Statement
  batch<T = Record<string, unknown>>(statements: AgentInvocationD1Statement[]): Promise<AgentInvocationD1Result<T>[]>
}

export interface AgentInvocationD1Statement {
  bind(...values: unknown[]): AgentInvocationD1Statement
  all<T = Record<string, unknown>>(): Promise<AgentInvocationD1Result<T>>
}

export interface AgentInvocationD1Result<T> {
  results: T[]
  meta: { changes: number }
}

export interface D1AgentInvocationStoreOptions {
  /** Resolved once per operation. Return the binding for the current request. */
  database: AgentInvocationD1Database | (() => AgentInvocationD1Database | Promise<AgentInvocationD1Database>)
  /** Maximum age of terminal records. Defaults to 30 days; false disables this limit. */
  maxAgeMs?: false | number
  /** Maximum count of terminal records. Defaults to 10,000; false disables this limit. */
  maxRecords?: false | number
  tablePrefix?: string
}

// D1 limits an entire row to 2 MB. Reserve room for duplicated metadata and search text.
const maximumObservationBytes = 1_000_000
const maximumRowBytes = 1_900_000
const encoder = new TextEncoder()

const terminal = "'completed', 'failed', 'cancelled'"
const clock = "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4) AS INTEGER))"

function tableName(prefix = "vitehub_agent_") {
  const table = `${prefix}invocations`
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new TypeError("[vitehub] D1 Agent Invocation tablePrefix must form an SQL identifier.")
  }
  return table
}

/** Apply these statements through your D1 migration tool before using the store. */
export function d1AgentInvocationSchema(options: Pick<D1AgentInvocationStoreOptions, "tablePrefix"> = {}): readonly string[] {
  const table = tableName(options.tablePrefix)
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      search TEXT NOT NULL,
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      record TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      claim_id TEXT,
      claim_token TEXT,
      claim_expires_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS ${table}_status_sequence ON ${table} (status, sequence DESC)`,
    `CREATE INDEX IF NOT EXISTS ${table}_status_updated_at ON ${table} (status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS ${table}_agent_name_sequence ON ${table} (agent_name, sequence DESC)`,
  ]
}

function retention(value: false | number | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === false) return false
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new TypeError("[vitehub] D1 Agent Invocation retention limits must be positive safe integers or false.")
  }
  return result
}

function serialize(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item)
}

interface RecordRow {
  sequence: number
  record: string
  revision: number
}

function record(row: RecordRow): AgentInvocationRecord {
  // SAFETY: The adapter reads its own JSON records from its explicitly migrated table.
  const stored = JSON.parse(row.record) as AgentInvocationStoreCreateInput
  return { ...stored, cursor: String(row.sequence) }
}

function summary(row: { sequence: number, summary: string }): AgentInvocationSummary {
  // SAFETY: The adapter writes summaries together with the full record in the same statement.
  return { ...JSON.parse(row.summary) as Omit<AgentInvocationSummary, "cursor">, cursor: String(row.sequence) }
}

function columns(input: AgentInvocationStoreCreateInput) {
  const { observations: _observations, ...metadata } = input
  return [input.status, input.agentName || "", searchableAgentInvocationText(input), serialize(metadata), input.updatedAt, serialize(input)]
}

function fitRecord(input: AgentInvocationStoreCreateInput, append = false) {
  const limits = observationLimits(input.observationLimits)
  limits.maxBytes = Math.min(limits.maxBytes, maximumObservationBytes)
  const retained = byteBoundedObservations(input.observations, limits)
  if (append && retained.truncated) throw new Error("[vitehub] D1 Agent Invocation byte capacity reached; evidence was not appended.")
  let stored = {
    ...input,
    observationLimits: limits,
    observations: retained.observations,
    ...(retained.truncated ? { observationsTruncated: true } : {}),
  }
  let values = columns(stored)
  // Include all repeated SQL text columns and leave the remaining provider budget for claims and row encoding.
  const rowBytes = () => [stored.id, ...values].reduce((bytes, value) => bytes + encoder.encode(value).byteLength, 0)
  if (rowBytes() > maximumRowBytes) {
    if (append) throw new Error("[vitehub] D1 Agent Invocation row byte capacity reached; evidence was not appended.")
    stored = { ...stored, observations: stored.observations.filter(isAppendedObservation), observationsTruncated: true }
    values = columns(stored)
  }
  if (rowBytes() > maximumRowBytes) {
    throw new TypeError("[vitehub] D1 Agent Invocation metadata exceeds the row byte limit while preserving appended evidence. Reduce metadata before storing this record.")
  }
  return { stored, values }
}

/** D1 journal with atomic batches and optimistic updates across Worker isolates. Does not create or migrate tables. */
export function createD1AgentInvocationStore(options: D1AgentInvocationStoreOptions): AgentInvocationStore {
  const table = tableName(options.tablePrefix)
  const maxAgeMs = retention(options.maxAgeMs, 30 * 24 * 60 * 60 * 1000, 8_640_000_000_000_000)
  const maxRecords = retention(options.maxRecords, 10_000)
  const database = async () => typeof options.database === "function" ? await options.database() : options.database
  const prune = (db: AgentInvocationD1Database) => {
    const filters: string[] = []
    const values: (string | number)[] = []
    if (maxAgeMs !== false) {
      filters.push("updated_at < ?")
      values.push(new Date(Date.now() - maxAgeMs).toISOString())
    }
    if (maxRecords !== false) {
      filters.push(`sequence NOT IN (SELECT sequence FROM ${table} WHERE status IN (${terminal}) ORDER BY sequence DESC LIMIT ?)`)
      values.push(maxRecords)
    }
    return filters.length
      ? [db.prepare(`DELETE FROM ${table} WHERE status IN (${terminal}) AND (${filters.join(" OR ")})`).bind(...values)]
      : []
  }
  return {
    async create(input) {
      const { stored, values } = fitRecord(input)
      const db = await database()
      const before = prune(db)
      const results = await db.batch<RecordRow>([
        ...before,
        db.prepare(`INSERT OR IGNORE INTO ${table} (id, status, agent_name, search, summary, updated_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(stored.id, ...values),
        ...prune(db),
        db.prepare(`SELECT sequence, record, revision FROM ${table} WHERE id = ?`).bind(input.id),
      ])
      const row = results.at(-1)?.results[0]
      if (!row) throw new Error(`[vitehub] D1 Agent Invocation ${JSON.stringify(input.id)} was removed by retention.`)
      return { created: results[before.length]!.meta.changes > 0, record: record(row) }
    },
    async get(id) {
      const db = await database()
      const result = await db.prepare(`SELECT sequence, record, revision FROM ${table} WHERE id = ?`).bind(id).all<RecordRow>()
      return result.results[0] ? record(result.results[0]) : undefined
    },
    async getSummary(id) {
      const db = await database()
      const result = await db.prepare(`SELECT sequence, summary FROM ${table} WHERE id = ?`).bind(id).all<{ sequence: number, summary: string }>()
      return result.results[0] ? summary(result.results[0]) : undefined
    },
    async claim(id, claimId, leaseMs, claimOptions) {
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError("[vitehub] D1 Agent Invocation leaseMs must be a positive safe integer.")
      if (encoder.encode(claimId).byteLength > 512) throw new TypeError("[vitehub] D1 Agent Invocation claimId must be at most 512 UTF-8 bytes.")
      const db = await database()
      const result = await db.prepare(`UPDATE ${table} SET revision = revision + 1, claim_id = ?, claim_token = ?, claim_expires_at = ${clock} + ?
        WHERE id = ? AND (claim_id IS NULL OR claim_id = ? OR claim_expires_at <= ${clock}
          OR ? = 1 OR (? IS NOT NULL AND claim_token = ?))`)
        .bind(claimId, crypto.randomUUID(), leaseMs, id, claimId, claimOptions?.replaceExisting ? 1 : 0, claimOptions?.replaceClaimToken ?? null, claimOptions?.replaceClaimToken ?? null).all()
      return result.meta.changes > 0
    },
    async getClaimToken(id) {
      const db = await database()
      const result = await db.prepare(`SELECT claim_token FROM ${table} WHERE id = ?`).bind(id).all<{ claim_token: string | null }>()
      return result.results[0]?.claim_token ?? undefined
    },
    async release(id, claimId) {
      const db = await database()
      await db.prepare(`UPDATE ${table} SET revision = revision + 1, claim_id = NULL, claim_token = NULL, claim_expires_at = NULL WHERE id = ? AND claim_id = ?`).bind(id, claimId).all()
    },
    async update(id, input, claimId) {
      const db = await database()
      const claimFilter = claimId === undefined ? "" : " AND claim_id = ?"
      const identity = claimId === undefined ? [id] : [id, claimId]
      let sequence: number | undefined
      // D1 has no interactive transactions. Retry the full update when another writer changes the revision.
      for (let attempt = 0; attempt < 32; attempt++) {
        const selected = await db.prepare(`SELECT sequence, record, revision FROM ${table} WHERE id = ?${claimFilter}`).bind(...identity).all<RecordRow>()
        const row = selected.results[0]
        if (!row || (sequence !== undefined && sequence !== row.sequence)) return undefined
        sequence = row.sequence
        const updated = applyAgentInvocationStoreUpdate(record(row), input)
        const { cursor: _cursor, ...inputRecord } = updated
        const { values } = fitRecord(inputRecord, input.appendObservation !== undefined)
        const result = await db.batch<RecordRow>([
          db.prepare(`UPDATE ${table} SET status = ?, agent_name = ?, search = ?, summary = ?, updated_at = ?, record = ?, revision = revision + 1
            WHERE id = ?${claimFilter} AND sequence = ? AND revision = ? RETURNING sequence, record, revision`).bind(...values, ...identity, row.sequence, row.revision),
          ...(updated.status === "completed" || updated.status === "failed" || updated.status === "cancelled" ? prune(db) : []),
        ])
        if (result[0]?.results[0]) return record(result[0].results[0])
      }
      throw new Error(`[vitehub] D1 Agent Invocation ${JSON.stringify(id)} update exceeded 32 concurrent write retries.`)
    },
    async list(listOptions = {}) {
      const limit = listOptions.limit ?? 50
      if (!Number.isInteger(limit) || limit < 1) throw new TypeError("[vitehub] Agent Invocation list limit must be a positive integer.")
      const pageSize = Math.min(limit, 100)
      const before = listOptions.cursor === undefined ? undefined : Number(listOptions.cursor)
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1 || String(before) !== listOptions.cursor)) throw new TypeError("[vitehub] Agent Invocation cursor is invalid.")
      const search = listOptions.search?.trim()
      if (search && search.length > 256) throw new TypeError("[vitehub] Agent Invocation search must be at most 256 characters.")
      const statuses = listOptions.status === undefined ? [] : Array.isArray(listOptions.status) ? listOptions.status : [listOptions.status]
      if (Array.isArray(listOptions.status) && !statuses.length) return { invocations: [] }
      const filters: string[] = []
      const values: (number | string)[] = []
      if (before !== undefined) {
        filters.push("sequence < ?")
        values.push(before)
      }
      if (statuses.length) {
        filters.push(`status IN (${statuses.map(() => "?").join(", ")})`)
        values.push(...statuses)
      }
      if (listOptions.agentName?.trim()) {
        filters.push("agent_name = ?")
        values.push(listOptions.agentName.trim())
      }
      if (listOptions.capabilityId?.trim()) {
        filters.push(`(EXISTS (SELECT 1 FROM json_each(record, '$.capabilityIds') WHERE value = ?)
          OR EXISTS (SELECT 1 FROM json_each(record, '$.observations') WHERE json_extract(value, '$.attributes."capability.id"') = ?))`)
        values.push(listOptions.capabilityId.trim(), listOptions.capabilityId.trim())
      }
      if (search) {
        filters.push("search LIKE ? ESCAPE '\\'")
        values.push(`%${search.toLowerCase().replace(/[\\%_]/g, match => `\\${match}`)}%`)
      }
      const db = await database()
      const result = await db.prepare(`SELECT sequence, summary FROM ${table}${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""} ORDER BY sequence DESC LIMIT ?`)
        .bind(...values, pageSize + 1).all<{ sequence: number, summary: string }>()
      const invocations = result.results.slice(0, pageSize).map(summary)
      return { ...(result.results.length > pageSize ? { cursor: invocations.at(-1)!.cursor } : {}), invocations }
    },
    async listAgentNames() {
      const db = await database()
      const result = await db.prepare(`SELECT DISTINCT agent_name FROM ${table} WHERE agent_name <> '' ORDER BY agent_name`).all<{ agent_name: string }>()
      return result.results.map(row => row.agent_name)
    },
    async listCapabilityIds(agentName) {
      const db = await database()
      const selectedAgent = agentName?.trim()
      const result = await db.prepare(`SELECT DISTINCT capability_id FROM (
        SELECT trim(value) AS capability_id, agent_name FROM ${table}, json_each(record, '$.capabilityIds') WHERE type = 'text'
        UNION ALL
        SELECT trim(json_extract(value, '$.attributes."capability.id"')) AS capability_id, agent_name
          FROM ${table}, json_each(record, '$.observations') WHERE json_type(value, '$.attributes."capability.id"') = 'text'
        ) WHERE capability_id <> ''${selectedAgent ? " AND agent_name = ?" : ""} ORDER BY capability_id`)
        .bind(...(selectedAgent ? [selectedAgent] : [])).all<{ capability_id: string }>()
      return result.results.map(row => row.capability_id)
    },
  }
}
