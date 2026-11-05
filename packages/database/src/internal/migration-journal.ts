import { existsSync, readFileSync } from "node:fs"

import { join } from "pathe"

import { findDataLoss } from "./migration-sql.ts"

import type { DataLossStatement, TableColumns } from "./migration-sql.ts"

/** A migration in the migrations folder that the database has not applied. */
export interface PendingMigration {
  dataLoss: DataLossStatement[]
  name: string
  statements: string[]
}

/** An entry of Drizzle Kit's `meta/_journal.json`. `when` is the `created_at` that Drizzle's ledger stores. */
export interface JournalEntry {
  idx: number
  tag: string
  when: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]"
}

export function readJournal(migrationsDir: string): JournalEntry[] {
  const file = join(migrationsDir, "meta", "_journal.json")
  if (!existsSync(file)) return []
  const journal: unknown = JSON.parse(readFileSync(file, "utf8"))
  const entries = isRecord(journal) ? journal.entries : undefined
  if (!Array.isArray(entries)) throw new Error(`${file} has no \`entries\` list.`)
  return entries.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.tag !== "string" || typeof entry.when !== "number" || typeof entry.idx !== "number") {
      throw new Error(`${file} has an entry without a string \`tag\` and number \`idx\` and \`when\`.`)
    }
    return { idx: entry.idx, tag: entry.tag, when: entry.when }
  })
}

/** Reads the table columns from the Drizzle snapshot of a journal entry. */
function readSnapshotColumns(migrationsDir: string, idx: number): TableColumns | undefined {
  const file = join(migrationsDir, "meta", `${String(idx).padStart(4, "0")}_snapshot.json`)
  if (!existsSync(file)) return
  let snapshot: unknown
  try {
    snapshot = JSON.parse(readFileSync(file, "utf8"))
  }
  catch {
    return
  }
  if (!isRecord(snapshot) || !isRecord(snapshot.tables)) return
  const tables = new Map<string, string[]>()
  for (const table of Object.values(snapshot.tables)) {
    if (!isRecord(table) || typeof table.name !== "string" || !isRecord(table.columns)) continue
    tables.set(table.name.toLowerCase(), Object.keys(table.columns))
  }
  return tables
}

export function readPendingMigration(migrationsDir: string, tag: string, entries: readonly JournalEntry[]): PendingMigration {
  const sql = readFileSync(join(migrationsDir, `${tag}.sql`), "utf8")
  const statements = sql.split("--> statement-breakpoint").map(statement => statement.trim()).filter(Boolean)
  // A hand-written D1 migration has no journal entry, so there is no previous snapshot to compare a rebuild with.
  const idx = entries.find(entry => entry.tag === tag)?.idx
  const before = idx === undefined ? undefined : idx > 0 ? readSnapshotColumns(migrationsDir, idx - 1) : new Map<string, string[]>()
  return { dataLoss: findDataLoss(statements, before), name: tag, statements }
}
