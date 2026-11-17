import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"

import { basename, join } from "pathe"

import { describeDatabaseContribution } from "../contributions.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { splitSqlStatements } from "./migration-sql.ts"

import type { ResolvedDatabaseMigrations } from "../contributions.ts"
import type { DatabaseDialect } from "../types.ts"

/** A `.sql` file of a contributed migrations folder. */
export interface ContributedMigration {
  contribution: ResolvedDatabaseMigrations
  /** Absolute path of the `.sql` file. */
  file: string
  /** The end of the migration folder name, after its timestamp. It identifies the file in the migrations folder. */
  key: string
}

export interface ContributedMigrationsPlan {
  /** Files that the migrations folder of the Database does not have yet, in the order they are added. */
  pending: ContributedMigration[]
  /** Files that the migrations folder has, with the folder that holds each one. */
  added: Array<ContributedMigration & { folder: string }>
}

const dialectSuffix = /\.(sqlite|postgresql|mysql)\.sql$/
const statementBreakpoint = "--> statement-breakpoint"

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}

/**
 * Lists the `.sql` files of a contributed migrations folder in file name order. A file named `<name>.<dialect>.sql`
 * applies only to a Database of that dialect. A missing folder fails with `DATABASE_INVALID_CONTRIBUTION`.
 */
export function listContributedMigrations(contribution: ResolvedDatabaseMigrations, dialect: DatabaseDialect): ContributedMigration[] {
  const dir = contribution.migrations
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION({ problem: `[vitehub] The migrations folder ${dir} of ${describeDatabaseContribution(contribution)} does not exist.` })
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".sql"))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .flatMap((name) => {
      const fileDialect = dialectSuffix.exec(name)?.[1]
      if (fileDialect && fileDialect !== dialect) return []
      const stem = name.replace(dialectSuffix, "").replace(/\.sql$/, "")
      return [{ contribution, file: join(dir, name), key: slug(`${contribution.name}_${stem}`) }]
    })
}

/** The contributed migrations of one Database: the ones its migrations folder has, and the ones it still needs. */
export function planContributedMigrations(
  migrationsDir: string,
  contributions: readonly ResolvedDatabaseMigrations[],
  dialect: DatabaseDialect,
): ContributedMigrationsPlan {
  const folders = new Map<string, string>()
  if (existsSync(migrationsDir)) {
    for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
      const key = entry.isDirectory() ? /^\d{14}_(.+)$/.exec(entry.name)?.[1] : undefined
      if (key && !folders.has(key)) folders.set(key, entry.name)
    }
  }
  const plan: ContributedMigrationsPlan = { added: [], pending: [] }
  const identities = new Map<string, string>()
  for (const contribution of contributions) {
    for (const migration of listContributedMigrations(contribution, dialect)) {
      const identity = JSON.stringify([contribution.name, basename(migration.file)])
      const previous = identities.get(migration.key)
      if (previous && previous !== identity) {
        throw databaseErrorDiagnostics.DATABASE_INVALID_CONTRIBUTION({ problem: `[vitehub] Contributed migration identity collision for ${migration.key}. Rename the contribution or SQL file.` })
      }
      identities.set(migration.key, identity)
      const folder = folders.get(migration.key)
      if (folder) plan.added.push({ ...migration, folder })
      else plan.pending.push(migration)
    }
  }
  return plan
}

/** `YYYYMMDDHHmmss` in UTC, the prefix that Drizzle Kit 1.0 gives a migration folder. */
function folderStamp(time: number): string {
  return new Date(time).toISOString().slice(0, 19).replace(/\D/g, "")
}

function folderTime(folder: string): number {
  const part = (start: number, end: number) => Number.parseInt(folder.slice(start, end), 10)
  return Date.UTC(part(0, 4), part(4, 6) - 1, part(6, 8), part(8, 10), part(10, 12), part(12, 14))
}

/** Move only newly generated folders past all committed history, including SQL-only folders. */
export function orderGeneratedMigrations(migrationsDir: string, foldersBefore: readonly string[]): void {
  if (!existsSync(migrationsDir)) return
  let newest = [...foldersBefore].sort().at(-1)
  const generated = readdirSync(migrationsDir).filter(name => /^\d{14}_/.test(name) && !foldersBefore.includes(name)).sort()
  for (const folder of generated) {
    let ordered = folder
    if (newest && folder.slice(0, 14) <= newest.slice(0, 14)) {
      ordered = `${folderStamp(folderTime(newest) + 1000)}_${folder.slice(15)}`
      renameSync(join(migrationsDir, folder), join(migrationsDir, ordered))
    }
    newest = ordered
  }
}

/**
 * The SQL of a contributed file as Drizzle's migrator needs it: one statement between two breakpoints. Drizzle runs
 * only the first statement of a part, so a file without breakpoints is split at the semicolons outside quotes and
 * comments. A file that already has breakpoints is copied as written.
 */
export function toMigrationSql(sql: string): string {
  if (sql.includes(statementBreakpoint)) return sql
  return `${splitSqlStatements(sql).join(`\n${statementBreakpoint}\n`)}\n`
}

/**
 * Adds each pending contributed migration to `migrationsDir` as a Drizzle Kit 1.0 folder,
 * `<YYYYMMDDHHmmss>_<key>/migration.sql`, after the newest folder there. Returns the new folder names.
 */
export function writeContributedMigrations(migrationsDir: string, pending: readonly ContributedMigration[], now = Date.now()): string[] {
  if (!pending.length) return []
  const newest = existsSync(migrationsDir)
    ? readdirSync(migrationsDir).filter(name => /^\d{14}_/.test(name)).sort().at(-1)
    : undefined
  let time = Math.max(Math.floor(now / 1000) * 1000, newest ? folderTime(newest) + 1000 : 0)
  return pending.map((migration) => {
    const folder = `${folderStamp(time)}_${migration.key}`
    time += 1000
    mkdirSync(join(migrationsDir, folder), { recursive: true })
    writeFileSync(join(migrationsDir, folder, "migration.sql"), toMigrationSql(readFileSync(migration.file, "utf8")))
    return folder
  })
}

/** Describes a contributed migration file for messages, such as `0001_feedback.sql from "feedback" (plugin "x")`. */
export function describeContributedMigration(migration: ContributedMigration): string {
  return `${basename(migration.file)} from ${describeDatabaseContribution(migration.contribution)}`
}
