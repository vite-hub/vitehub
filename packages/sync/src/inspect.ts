import { and, asc, count, desc, eq, lt, max, ne, sql } from "drizzle-orm"

import { syncTriggerNames } from "./capture.ts"
import { syncChanges, syncColumns, syncState } from "./database.ts"
import { describeSyncTable } from "./define.ts"
import { syncErrors } from "./errors.ts"

import type { InstalledSync } from "./runtime.ts"

/** One Sync definition of the running app, as `sync.list` shows it. */
export interface SyncSummary {
  name: string
  /** The SQL name of the table. */
  table: string
  /** The primary key column. */
  key: string
  /** `yes`, `no` for `write: false`, or `check` for a `write` function. */
  write: "yes" | "no" | "check"
  /** Whether browsers may keep a live stream open (`live` of the definition). */
  live: boolean
  /** The columns that a browser may load a subset by (`subsets` of the definition). */
  subsets: string[]
  /** The names of the actions of the definition. */
  actions: string[]
  rows: number
  /** Entries in the change log: one `put` for each changed key, and the exits. */
  changes: number
  /** Exits in the change log: one for each delete or move in the last 30 days. */
  exits: number
  /** The lowest cursor that a pull continues from. An older cursor gets a full snapshot. */
  floor: number
  /** The newest `seq`, the cursor of a client that has every change. */
  lastSeq: number
  /** Whether the table has the three triggers that write the change log. Sync adds them at its first request. */
  triggers: boolean
  /** The SQL names of the scope columns: a change of one of them records a `move`. */
  scopeColumns: string[]
}

/** One entry of the change log. It has no row data. */
export interface SyncChangeEntry {
  seq: number
  key: string
  /** `put` for an insert or update, `delete` or `move` for a row that left a scope. */
  op: "put" | "delete" | "move"
  createdAt: number
}

export async function summarizeSync(installed: InstalledSync): Promise<SyncSummary[]> {
  return await Promise.all(installed.names.map(async (name) => {
    const definition = installed.definition(name)!
    const table = describeSyncTable(definition.options.table)
    const db = installed.db(name)
    const [rows, changes, exits, state, triggers, columns] = await db.batch([
      db.select({ count: count() }).from(table.table),
      db.select({ count: count(), last: max(syncChanges.seq) }).from(syncChanges).where(eq(syncChanges.tableName, table.name)),
      db.select({ count: count() }).from(syncChanges).where(and(eq(syncChanges.tableName, table.name), ne(syncChanges.op, "put"))),
      db.select({ floor: syncState.floor }).from(syncState).where(eq(syncState.tableName, table.name)),
      db.all<{ count: number }>(sql`SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN (${sql.join(syncTriggerNames(table.name).map(trigger => sql`${trigger}`), sql`, `)})`),
      db.select({ column: syncColumns.column }).from(syncColumns).where(eq(syncColumns.tableName, table.name)).orderBy(asc(syncColumns.column)),
    ])
    const { write, live, actions, subsets } = definition.options
    return {
      name,
      table: table.name,
      key: table.key,
      write: write === false ? "no" : typeof write === "function" ? "check" : "yes",
      live: live !== false,
      subsets: [...subsets ?? []],
      actions: Object.keys(actions ?? {}).sort(),
      rows: rows[0]?.count ?? 0,
      changes: changes[0]?.count ?? 0,
      exits: exits[0]?.count ?? 0,
      floor: state[0]?.floor ?? 0,
      lastSeq: changes[0]?.last ?? 0,
      triggers: triggers[0]?.count === syncTriggerNames(table.name).length,
      scopeColumns: columns.map(row => row.column),
    }
  }))
}

export async function listSyncChanges(installed: InstalledSync, name: string, options: { limit?: number, before?: number } = {}): Promise<SyncChangeEntry[]> {
  const definition = installed.definition(name)
  if (!definition) throw syncErrors.SYNC_UNKNOWN_NAME({ name })
  const table = describeSyncTable(definition.options.table).name
  const { before } = options
  return await installed.db(name)
    .select({ seq: syncChanges.seq, key: syncChanges.key, op: syncChanges.op, createdAt: syncChanges.createdAt })
    .from(syncChanges)
    .where(and(eq(syncChanges.tableName, table), before === undefined ? undefined : lt(syncChanges.seq, before)))
    .orderBy(desc(syncChanges.seq))
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 500))
}
