import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { copyFile, mkdir } from "node:fs/promises"

import { join } from "pathe"

import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { applyD1MigrationFiles, createD1QueryAt, d1MigrationNamesFile, defaultD1MigrationsTable, readD1LedgerOf } from "./d1-ledger.ts"

import type { AdoptedMigration, D1Ledger, D1Query } from "./d1-ledger.ts"
import type { MigrationEntry } from "./migration-journal.ts"

export { d1MigrationNamesFile, defaultD1MigrationsTable }
export type { AdoptedMigration, D1Ledger, D1Query }

export interface D1HttpTarget {
  accountId?: string
  databaseId?: string
  token?: string
  proxy?: { url?: string, token?: string }
}

/**
 * Sends SQL to the Cloudflare D1 HTTP API or a configured proxy. Returns the rows of the last statement.
 * `fail` makes the caller's error for a problem, so each command throws its own code.
 */
export function createD1Query(target: D1HttpTarget, fail: (problem: string) => Error, request: typeof fetch = fetch): D1Query {
  const missing = (target.proxy ? [
    !target.proxy.url && "`cloudflare.http.url`",
    !target.proxy.token && "`cloudflare.http.authToken`",
  ] : [
    !target.accountId && "`CLOUDFLARE_ACCOUNT_ID`",
    !target.token && "`CLOUDFLARE_API_TOKEN`",
    !target.databaseId && "a value for `cloudflare.databaseId`",
  ]).filter(Boolean)
  if (missing.length) throw fail(`ViteHub applies D1 HTTP migrations with ${target.proxy ? "the configured proxy" : "the Cloudflare API"}, which needs ${missing.join(" and ")}.`)
  const url = target.proxy
    ? target.proxy.url!
    : `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(target.accountId!)}/d1/database/${encodeURIComponent(target.databaseId!)}/query`
  if (!["http:", "https:"].includes(new URL(url).protocol)) throw fail("D1 HTTP migrations need an HTTP or HTTPS URL for `cloudflare.http.url`.")
  return createD1QueryAt(url, target.proxy ? target.proxy.token : target.token, fail, request)
}

/** A migration as Wrangler applies it: its `.sql` file name in the ledger, and the SQL file it comes from. */
export interface D1MigrationFile {
  name: string
  source: string
  /** The Drizzle Kit folder, or the flat file name without `.sql`. */
  tag: string
}

const folderTag = /^\d{14}_(.+)$/

function readD1MigrationNames(migrationsDir: string): Record<string, string> {
  const file = join(migrationsDir, d1MigrationNamesFile)
  if (!existsSync(file)) return {}
  const shape = `${file} must map each migration folder to its Wrangler file name, such as { "20261109120000_init": "0000_init.sql" }.`
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, "utf8"))
  }
  catch {
    // For example the markers of a merge conflict.
    throw databaseErrorDiagnostics.DATABASE_D1_MIGRATION_INVALID({ problem: `${file} is not valid JSON. Fix the JSON. ${shape}` })
  }
  const valid = isRecord(value) && !Array.isArray(value) && Object.values(value).every(name => typeof name === "string" && name.endsWith(".sql"))
  if (!valid) throw databaseErrorDiagnostics.DATABASE_D1_MIGRATION_INVALID({ problem: shape })
  return value as Record<string, string>
}

function migrationNumber(name: string): number {
  const number = Number.parseInt(name.split("_")[0]!, 10)
  return Number.isFinite(number) ? number : -1
}

/**
 * Lists the migrations of a directory with the `.sql` file names that Wrangler applies, in Wrangler's order.
 *
 * `d1-migrations.json` next to the migrations keeps the Wrangler name of each migration folder, such as
 * `{ "20261109120000_init": "0000_init.sql" }`. Commit it: a listed folder keeps its name, so a folder that sorts
 * before applied ones, for example after a merge, cannot renumber them.
 *
 * A Drizzle Kit folder takes its name from `d1-migrations.json`. A folder that the file does not list gets the next
 * number, `NNNN_<name>.sql`. Without the file, the numbers follow the folder order, which gives each folder the name
 * that Drizzle Kit 0.x gave the same migration, because `drizzle-kit up` keeps that order and name. So a converted
 * migration keeps its row in Wrangler's `d1_migrations` and does not run again. A flat `.sql` file, such as one from
 * `wrangler d1 migrations create`, keeps its name.
 */
export function listD1Migrations(migrationsDir: string): D1MigrationFile[] {
  if (!existsSync(migrationsDir)) return []
  const entries = readdirSync(migrationsDir, { withFileTypes: true })
  const recorded = readD1MigrationNames(migrationsDir)
  const flat = entries.filter(entry => entry.isFile() && entry.name.endsWith(".sql")).map(entry => entry.name)
  const folders = entries
    .filter(entry => entry.isDirectory() && existsSync(join(migrationsDir, entry.name, "migration.sql")))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))
  let next = Math.max(-1, ...Object.values(recorded).map(migrationNumber), ...flat.map(migrationNumber)) + 1
  // Without the file, number every folder in order from 0000, as Drizzle Kit 0.x did, flat files aside.
  if (!Object.keys(recorded).length) next = 0
  const files: D1MigrationFile[] = folders.map(tag => ({
    name: recorded[tag] ?? `${String(next++).padStart(4, "0")}_${folderTag.exec(tag)?.[1] ?? tag}.sql`,
    source: join(migrationsDir, tag, "migration.sql"),
    tag,
  }))
  for (const name of flat) {
    const folder = files.find(file => file.name === name)
    if (folder) {
      throw databaseErrorDiagnostics.DATABASE_D1_MIGRATION_INVALID({ problem: `${join(migrationsDir, name)} has the Wrangler name of the migration folder ${folder.tag}. Rename the file, for example with the next free number.` })
    }
    files.push({ name, source: join(migrationsDir, name), tag: name.slice(0, -".sql".length) })
  }
  const duplicate = files.find((file, index) => files.findIndex(other => other.name === file.name) !== index)
  if (duplicate) throw databaseErrorDiagnostics.DATABASE_D1_MIGRATION_INVALID({ problem: `${join(migrationsDir, d1MigrationNamesFile)} gives two migrations the Wrangler name ${duplicate.name}. Give one of them the next free number.` })
  return files.sort((a, b) => {
    const aNumber = Number.parseInt(a.name.split("_")[0]!, 10)
    const bNumber = Number.parseInt(b.name.split("_")[0]!, 10)
    if (aNumber !== bNumber) {
      if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber
      if (Number.isFinite(aNumber)) return -1
      if (Number.isFinite(bNumber)) return 1
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

/** Writes `d1-migrations.json` when it does not list every migration folder yet. Returns the migrations. */
export function recordD1MigrationNames(migrationsDir: string): D1MigrationFile[] {
  const files = listD1Migrations(migrationsDir)
  const recorded = readD1MigrationNames(migrationsDir)
  const folders = files.filter(file => file.source.endsWith("/migration.sql"))
  if (folders.length && folders.some(file => recorded[file.tag] !== file.name)) {
    const names = Object.fromEntries([...Object.entries(recorded), ...folders.map(file => [file.tag, file.name] as const)].sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(join(migrationsDir, d1MigrationNamesFile), `${JSON.stringify(names, null, 2)}\n`)
  }
  return files
}

/** Writes the migrations of `migrationsDir` into `outputDir` as the flat `.sql` files that Wrangler reads from `migrations_dir`. */
export async function copyD1MigrationFiles(migrationsDir: string, outputDir: string): Promise<void> {
  const files = recordD1MigrationNames(migrationsDir)
  await mkdir(outputDir, { recursive: true })
  await Promise.all(files.map(file => copyFile(file.source, join(outputDir, file.name))))
}

/** Reads the applied migrations of `migrationsDir` from the ledgers on the database. See `readD1LedgerOf()`. */
export async function readD1Ledger(
  query: D1Query,
  { cloudflare, migrationsDir }: { cloudflare?: { migrationsTable?: string }, migrationsDir: string },
  migrations: readonly MigrationEntry[],
): Promise<D1Ledger> {
  return await readD1LedgerOf(query, cloudflare?.migrationsTable ?? defaultD1MigrationsTable, listD1Migrations(migrationsDir), migrations)
}

/** Applies the pending migrations of `migrationsDir` like `wrangler d1 migrations apply --remote`. */
export async function applyD1Migrations(
  query: D1Query,
  ledger: D1Ledger,
  migrationsDir: string,
  onApplied: (name: string) => void,
  onAdopted: (migration: AdoptedMigration) => void,
): Promise<void> {
  const files = recordD1MigrationNames(migrationsDir).map(file => ({ name: file.name, sql: () => readFileSync(file.source, "utf8") }))
  await applyD1MigrationFiles(query, ledger, files, onApplied, onAdopted)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]"
}
