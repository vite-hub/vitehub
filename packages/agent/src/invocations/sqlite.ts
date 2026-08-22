import { createClient } from "@libsql/client"

import { applyAgentInvocationStoreUpdate } from "../invocations.ts"

import type {
  AgentInvocationListOptions,
  AgentInvocationListResult,
  AgentInvocationRecord,
  AgentInvocationStore,
  AgentInvocationStoreCreateInput,
} from "../invocations.ts"
import type { Client } from "@libsql/client"

export interface LibsqlAgentInvocationStoreOptions {
  authToken?: string
  client?: Client
  tablePrefix?: string
  url?: string
}

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

function deserialize(value: unknown, cursor: unknown): AgentInvocationRecord | undefined {
  if (typeof value !== "string") return
  const record = JSON.parse(value) as Omit<AgentInvocationRecord, "cursor">
  return { ...record, cursor: String(cursor) }
}

function storedRecord(record: AgentInvocationRecord): Omit<AgentInvocationRecord, "cursor"> {
  const { cursor: _cursor, ...stored } = record
  return stored
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

export function createLibsqlAgentInvocationStore(options: LibsqlAgentInvocationStoreOptions = {}): AgentInvocationStore {
  if (!options.client && !options.url) {
    throw new TypeError("[vitehub] SQLite Agent Invocations require url or client.")
  }
  const client = options.client || createClient({
    ...(options.authToken ? { authToken: options.authToken } : {}),
    url: options.url!,
  })
  const table = tableName(options.tablePrefix)
  let initialized: Promise<void> | undefined
  let writes = Promise.resolve()
  const write = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writes.then(operation, operation)
    writes = result.then(() => undefined, () => undefined)
    return result
  }
  const initialize = async () => {
    if (!initialized) initialized = (async () => {
      await client.execute(`CREATE TABLE IF NOT EXISTS ${table} (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        record TEXT NOT NULL
      )`)
      await client.execute(`CREATE INDEX IF NOT EXISTS ${table}_status_sequence ON ${table} (status, sequence DESC)`)
      await client.execute(`CREATE TABLE IF NOT EXISTS ${table}_claims (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`)
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
  return {
    async claim(id, claimId, leaseMs, force) {
      return write(async () => {
        await initialize()
        const result = await client.execute({
          args: [id, claimId, leaseMs, id, force ? 1 : 0],
          sql: `INSERT INTO ${table}_claims (id, claim_id, expires_at)
            SELECT ?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER) + ? WHERE EXISTS (SELECT 1 FROM ${table} WHERE id = ?)
            ON CONFLICT(id) DO UPDATE SET claim_id = excluded.claim_id, expires_at = excluded.expires_at
            WHERE ? = 1 OR ${table}_claims.claim_id = excluded.claim_id
              OR ${table}_claims.expires_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)`,
        })
        return result.rowsAffected > 0
      })
    },
    async create(input: AgentInvocationStoreCreateInput) {
      return write(async () => {
        await initialize()
        const result = await client.execute({
          args: [input.id, input.status, serialize(input)],
          sql: `INSERT OR IGNORE INTO ${table} (id, status, record) VALUES (?, ?, ?)`,
        })
        const record = await read(input.id)
        if (!record) throw new Error(`[vitehub] SQLite Agent Invocation ${JSON.stringify(input.id)} was not persisted.`)
        return { created: result.rowsAffected > 0, record }
      })
    },
    get: read,
    async list(listOptions: AgentInvocationListOptions = {}): Promise<AgentInvocationListResult> {
      await initialize()
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
      const search = searchValue(listOptions.search)
      if (search) {
        filters.push("json_remove(record, '$.observations') LIKE ? ESCAPE '\\' COLLATE NOCASE")
        args.push(`%${search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`)
      }
      args.push(limit + 1)
      const result = await client.execute({
        args,
        sql: `SELECT sequence, record FROM ${table}${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""} ORDER BY sequence DESC LIMIT ?`,
      })
      const records = result.rows
        .map(row => deserialize(row.record, row.sequence))
        .filter((record): record is AgentInvocationRecord => Boolean(record))
      const page = records.slice(0, limit)
      return {
        ...(records.length > limit && page.length ? { cursor: page.at(-1)!.cursor } : {}),
        invocations: page.map((record) => {
          const { observations: _observations, ...summary } = record
          return summary
        }),
      }
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
          await transaction.execute({
            args: [updated.status, serialize(storedRecord(updated)), id],
            sql: `UPDATE ${table} SET status = ?, record = ? WHERE id = ?`,
          })
          await transaction.commit()
          return updated
        }
        catch (error) {
          await transaction.rollback()
          throw error
        }
        finally {
          await transaction.close()
        }
      })
    },
  }
}
