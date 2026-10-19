import { agentDiagnostics } from "../agent-diagnostics.ts"
import { isRuntimeRecord } from "./runtime-type.ts"

import type { DatabaseSync } from "node:sqlite"

/**
 * A SQLite Agent Invocation journal file opened read-only. The values are unvalidated JSON from the file;
 * callers check them with the same parsers that check an inspection endpoint's responses.
 */
export interface AgentInvocationJournalFile {
  close: () => void
  /** The record and every observation, or undefined when the journal has no record with this id. */
  get: (id: string) => { invocation: Record<string, unknown>, observations: unknown[] } | undefined
  /** Newest first, as the SQLite store lists. `cursor` continues after the last record of the previous page. */
  list: (options: { cursor?: string, limit: number, status?: string }) => { cursor?: string, invocations: Record<string, unknown>[] }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return
  try {
    return JSON.parse(value)
  }
  catch {
    return
  }
}

/**
 * Open the journal that `createLibsqlAgentInvocationStore()` writes, without its migrations and without any write.
 * This lets the CLI read the journal of a running app from inside its container. It reads journals written before
 * the `summary` column or the observations table existed: running records keep appended observations in that table.
 */
export async function openAgentInvocationJournalFile(path: string, tablePrefix = "vitehub_agent_"): Promise<AgentInvocationJournalFile> {
  const table = `${tablePrefix}invocations`
  if (!/^[A-Za-z_]\w*$/.test(table)) throw agentDiagnostics.AGENT_R0931({ message: "--table-prefix must be alphanumeric." })
  let sqlite: typeof import("node:sqlite")
  try {
    sqlite = await import("node:sqlite")
  }
  catch {
    throw agentDiagnostics.AGENT_R0931({ message: "--database reads the journal with node:sqlite, which this runtime does not provide. Run the command with Node.js 24, or pass --url." })
  }
  const db: DatabaseSync = new sqlite.DatabaseSync(path, { readOnly: true })
  try {
    // The app keeps writing while the CLI reads. Wait for its write lock instead of failing at once.
    db.exec("PRAGMA busy_timeout = 5000")
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name))
    if (!tables.has(table)) throw agentDiagnostics.AGENT_R0931({ message: `No Agent Invocation journal table ${table} exists in ${path}.` })
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name))
    const fromRecord = "CASE WHEN json_valid(record) THEN json_remove(record, '$.observations') END"
    const summary = columns.has("summary") ? `COALESCE(summary, ${fromRecord})` : fromRecord
    const list = db.prepare(`SELECT sequence, ${summary} AS summary FROM ${table}
      WHERE (:before IS NULL OR sequence < :before) AND (:status IS NULL OR status = :status)
      ORDER BY sequence DESC LIMIT :limit`)
    const record = db.prepare(`SELECT sequence, record FROM ${table} WHERE id = ?`)
    const appended = tables.has(`${table}_observations`)
      ? db.prepare(`SELECT observation FROM ${table}_observations WHERE invocation_sequence = ? ORDER BY position`)
      : undefined
    return {
      close: () => db.close(),
      get(id) {
        db.exec("BEGIN")
        try {
          const row = record.get(id)
          const stored = parseJson(row?.record)
          if (!row || !isRuntimeRecord(stored)) return
          const { observations, ...invocation } = stored
          return {
            invocation: { ...invocation, cursor: String(row.sequence) },
            observations: [
              ...Array.isArray(observations) ? observations : [],
              ...appended?.all(row.sequence).map(item => parseJson(item.observation)) ?? [],
            ],
          }
        }
        finally {
          db.exec("ROLLBACK")
        }
      },
      list({ cursor, limit, status }) {
        const before = cursor === undefined ? null : Number(cursor)
        const rows = list.all({ before: Number.isSafeInteger(before) ? before : null, limit: limit + 1, status: status ?? null })
        const invocations = rows.flatMap((row) => {
          const value = parseJson(row.summary)
          return isRuntimeRecord(value) ? [{ ...value, cursor: String(row.sequence) }] : []
        })
        const page = invocations.slice(0, limit)
        return { ...(rows.length > limit && page.length ? { cursor: page.at(-1)!.cursor } : {}), invocations: page }
      },
    }
  }
  catch (error) {
    db.close()
    throw error
  }
}
