import { and, count, desc, eq, lt, max, ne } from "drizzle-orm"

import { syncChanges, syncState } from "./database.ts"
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
  /** The highest `seq` that compaction removed. An older cursor gets a full snapshot. */
  floor: number
  /** The newest `seq`, the cursor of a client that has every change. */
  lastSeq: number
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
    const [rows, changes, exits, state] = await db.batch([
      db.select({ count: count() }).from(table.table),
      db.select({ count: count(), last: max(syncChanges.seq) }).from(syncChanges).where(eq(syncChanges.name, name)),
      db.select({ count: count() }).from(syncChanges).where(and(eq(syncChanges.name, name), ne(syncChanges.op, "put"))),
      db.select({ floor: syncState.floor }).from(syncState).where(eq(syncState.name, name)),
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
    }
  }))
}

export async function listSyncChanges(installed: InstalledSync, name: string, options: { limit?: number, before?: number } = {}): Promise<SyncChangeEntry[]> {
  if (!installed.definition(name)) throw syncErrors.SYNC_UNKNOWN_NAME({ name })
  const { before } = options
  return await installed.db(name)
    .select({ seq: syncChanges.seq, key: syncChanges.key, op: syncChanges.op, createdAt: syncChanges.createdAt })
    .from(syncChanges)
    .where(and(eq(syncChanges.name, name), before === undefined ? undefined : lt(syncChanges.seq, before)))
    .orderBy(desc(syncChanges.seq))
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 500))
}
