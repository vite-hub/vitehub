import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"

import { join } from "pathe"

import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { findDataLoss, splitSqlStatements } from "./migration-sql.ts"

import type { DataLossStatement, TableColumns } from "./migration-sql.ts"

/** A migration in the migrations folder that the database has not applied. */
export interface PendingMigration {
  dataLoss: DataLossStatement[]
  name: string
  statements: string[]
}

/** A migration that Drizzle Kit 1.0 writes as `<YYYYMMDDHHmmss>_<name>/migration.sql` beside its `snapshot.json`. */
export interface MigrationEntry {
  /** SHA-256 of `migration.sql`, the `hash` that Drizzle's ledger stores. */
  hash: string
  /** The folder name, the `name` that Drizzle's ledger stores. */
  tag: string
  /** The folder timestamp in milliseconds, the `created_at` that Drizzle's ledger stores. */
  when: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]"
}

/** The UTC time of the `YYYYMMDDHHmmss` prefix of a migration folder, as Drizzle's migrator reads it. */
function folderMillis(tag: string): number {
  const part = (start: number, end: number) => Number.parseInt(tag.slice(start, end), 10)
  return Date.UTC(part(0, 4), part(4, 6) - 1, part(6, 8), part(8, 10), part(10, 12), part(12, 14))
}

/** The SQL file of a migration: `<tag>/migration.sql`, or `<tag>.sql` for a flat file such as a hand-written D1 migration. */
export function migrationSqlFile(migrationsDir: string, tag: string): string {
  const folder = join(migrationsDir, tag, "migration.sql")
  return existsSync(folder) ? folder : join(migrationsDir, `${tag}.sql`)
}

/** Reports whether `migrationsDir` has the layout of Drizzle Kit 0.x, which `vitehub database up` converts. */
export function hasDrizzleKit0xLayout(migrationsDir: string): boolean {
  return existsSync(join(migrationsDir, "meta", "_journal.json"))
}

/** Reads the migration folders of `migrationsDir` in the order that Drizzle's migrator applies them. */
export function readMigrations(migrationsDir: string, database?: string): MigrationEntry[] {
  if (!existsSync(migrationsDir)) return []
  if (hasDrizzleKit0xLayout(migrationsDir)) throw databaseErrorDiagnostics.DATABASE_MIGRATIONS_OLD_LAYOUT({ database, dir: migrationsDir })
  return readdirSync(migrationsDir, { withFileTypes: true })
    // A generated folder without its SQL is incomplete history, even though Drizzle 1.0 silently skips it.
    .filter(entry => entry.isDirectory() && (/^\d{14}_/.test(entry.name) || existsSync(join(migrationsDir, entry.name, "migration.sql"))))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map(tag => ({
      hash: createHash("sha256").update(readFileSync(join(migrationsDir, tag, "migration.sql"), "utf8")).digest("hex"),
      tag,
      when: folderMillis(tag),
    }))
}

/** Reads the table columns from the Drizzle snapshot of a migration folder. */
function readSnapshotColumns(migrationsDir: string, tag: string): TableColumns | undefined {
  const file = join(migrationsDir, tag, "snapshot.json")
  if (!existsSync(file)) return
  let snapshot: unknown
  try {
    snapshot = JSON.parse(readFileSync(file, "utf8"))
  }
  catch {
    return
  }
  if (!isRecord(snapshot) || !Array.isArray(snapshot.ddl)) return
  const tables = new Map<string, string[]>()
  for (const entity of snapshot.ddl) {
    if (!isRecord(entity) || typeof entity.name !== "string") continue
    if (entity.entityType === "tables" && !tables.has(entity.name.toLowerCase())) tables.set(entity.name.toLowerCase(), [])
    if (entity.entityType === "columns" && typeof entity.table === "string") {
      const columns = tables.get(entity.table.toLowerCase()) ?? []
      columns.push(entity.name)
      tables.set(entity.table.toLowerCase(), columns)
    }
  }
  return tables
}

export function readPendingMigration(migrationsDir: string, tag: string, entries: readonly MigrationEntry[]): PendingMigration {
  const sql = readFileSync(migrationSqlFile(migrationsDir, tag), "utf8")
  const statements = sql.split("--> statement-breakpoint").map(statement => statement.trim()).filter(statement => splitSqlStatements(statement).length)
  // A hand-written D1 migration has no folder, so there is no previous snapshot to compare a rebuild with.
  const index = entries.findIndex(entry => entry.tag === tag)
  let before: TableColumns | undefined = index < 0 ? undefined : new Map<string, string[]>()
  for (let previous = index - 1; previous >= 0; previous--) {
    before = readSnapshotColumns(migrationsDir, entries[previous]!.tag)
    if (before) break
    // Index-only SQL cannot change table columns. Anything else leaves the schema unknown;
    // never carry a stale snapshot across arbitrary contributed DDL.
    const intervening = splitSqlStatements(readFileSync(migrationSqlFile(migrationsDir, entries[previous]!.tag), "utf8"))
    if (!intervening.every(statement => /^\s*(?:CREATE\s+(?:UNIQUE\s+)?INDEX\s|DROP\s+INDEX\s)/i.test(statement))) break
    before = new Map<string, string[]>()
  }
  return { dataLoss: findDataLoss(statements, before), name: tag, statements }
}
