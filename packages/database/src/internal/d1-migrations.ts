import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { copyFile, mkdir } from "node:fs/promises"

import { join } from "pathe"

import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { findRenumbered, matchLedger, matchRecordedNames, nameLedgerTables, toLedgerRow } from "./migration-ledger.ts"

import type { MigrationEntry } from "./migration-journal.ts"

/** Wrangler's default ledger. `wrangler d1 migrations apply` and `vitehub database migrate` share it. */
export const defaultD1MigrationsTable = "d1_migrations"

// Drizzle Kit's ledger. ViteHub used it for D1 HTTP before it used Wrangler's ledger.
const drizzleMigrationsTable = "__drizzle_migrations"

export interface D1HttpTarget {
  accountId?: string
  databaseId?: string
  token?: string
  proxy?: { url?: string, token?: string }
}

export type D1Query = (sql: string, params?: unknown[]) => Promise<unknown[]>

/** A migration that a ledger lists, but not the Wrangler table under its file name. */
export interface AdoptedMigration {
  /** The ledger that lists it. */
  from: string
  /** The Wrangler file name. */
  name: string
  tag: string
}

export interface D1Ledger {
  /** File names of the applied migrations. */
  applied: ReadonlySet<string>
  /** Applied migrations that the Wrangler table does not list yet. `vitehub database migrate` records them first. */
  adopted: readonly AdoptedMigration[]
  /** Whether the Wrangler table exists. */
  exists: boolean
  table: string
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
  const token = target.proxy ? target.proxy.token : target.token
  return async (sql, params = []) => {
    const response = await request(url, {
      body: JSON.stringify({ params, sql }),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      method: "POST",
    })
    const payload: unknown = await response.json().catch(() => undefined)
    const rows = readD1Rows(payload)
    if (!response.ok || !rows) throw fail(`Cloudflare D1 returned HTTP ${response.status}${describeD1Errors(payload)}.`)
    return rows
  }
}

/** A migration as Wrangler applies it: its `.sql` file name in the ledger, and the SQL file it comes from. */
export interface D1MigrationFile {
  name: string
  source: string
  /** The Drizzle Kit folder, or the flat file name without `.sql`. */
  tag: string
}

const folderTag = /^\d{14}_(.+)$/

/**
 * The file next to the migrations that keeps the Wrangler name of each migration folder, such as
 * `{ "20261109120000_init": "0000_init.sql" }`. Commit it: a listed folder keeps its name, so a folder that sorts
 * before applied ones, for example after a merge, cannot renumber them.
 */
export const d1MigrationNamesFile = "d1-migrations.json"

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

/**
 * Reads the applied migrations from Wrangler's migrations table and from the other ledgers on the database: NuxtHub's
 * `_hub_migrations`, Wrangler's default `d1_migrations`, and Drizzle Kit's `__drizzle_migrations`. A migration counts
 * as applied when a ledger lists its file name, its name without `.sql`, its folder, or the old file that its folder
 * keeps in its name, or, in Drizzle Kit's ledger, its SQL hash. So a database keeps its state after a move from
 * NuxtHub or a change of the migrations layout.
 */
export async function readD1Ledger(
  query: D1Query,
  { cloudflare, migrationsDir }: { cloudflare?: { migrationsTable?: string }, migrationsDir: string },
  migrations: readonly MigrationEntry[],
): Promise<D1Ledger> {
  const migrationsTable = cloudflare?.migrationsTable ?? defaultD1MigrationsTable
  const nameTables = [migrationsTable, ...nameLedgerTables.filter(table => table !== migrationsTable)]
  const candidates = [...nameTables, drizzleMigrationsTable]
  const tables = new Set((await query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${candidates.map(() => "?").join(", ")})`, candidates))
    .map(row => readRowValue(row, "name", 0)))
  const files = listD1Migrations(migrationsDir)
  const applied = new Map<string, string>()
  let listed = new Set<string>()
  // Ledger names that match no migration, and the table of each.
  const unmatched = new Map<string, string>()
  for (const table of nameTables) {
    if (!tables.has(table)) continue
    const names = (await query(`SELECT name FROM ${quoteIdentifier(table)}`)).map(row => String(readRowValue(row, "name", 0)))
    if (table === migrationsTable) listed = new Set(names)
    const match = matchRecordedNames(names, files)
    for (const tag of match.applied.keys()) applied.set(tag, applied.get(tag) ?? table)
    for (const name of match.unmatched) unmatched.set(name, table)
  }
  if (tables.has(drizzleMigrationsTable)) {
    // ViteHub wrote this ledger as Drizzle Kit 0.x did, without `name`, so rows match by time and hash.
    const rows = await query(`SELECT id, hash, created_at FROM ${drizzleMigrationsTable}`)
    const match = matchLedger(rows.map(row => toLedgerRow({
      created_at: readRowValue(row, "created_at", 2),
      hash: readRowValue(row, "hash", 1),
      id: readRowValue(row, "id", 0),
    })), migrations)
    for (const tag of match.applied) applied.set(tag, applied.get(tag) ?? drizzleMigrationsTable)
  }
  const renumbered = findRenumbered([...unmatched.keys()], files, new Set(applied.keys()))
  if (renumbered) {
    const { moved, name } = renumbered
    throw databaseErrorDiagnostics.DATABASE_D1_MIGRATION_INVALID({ problem: `The migrations table ${unmatched.get(name)} lists ${name}, but that migration is now ${moved.name} (${moved.tag}). Wrangler would apply it again. Restore ${d1MigrationNamesFile} next to the migrations, or set "${moved.tag}": "${name.replace(/\.sql$/, "")}.sql" in it.` })
  }
  const appliedFiles = files.filter(file => applied.has(file.tag))
  return {
    adopted: appliedFiles.filter(file => !listed.has(file.name)).map(file => ({ from: applied.get(file.tag)!, name: file.name, tag: file.tag })),
    applied: new Set(appliedFiles.map(file => file.name)),
    exists: tables.has(migrationsTable),
    table: migrationsTable,
  }
}

/**
 * Applies the pending migrations like `wrangler d1 migrations apply --remote`. Each file and its ledger row go in one
 * request, so D1 rolls back both when the file fails.
 */
export async function applyD1Migrations(
  query: D1Query,
  ledger: D1Ledger,
  migrationsDir: string,
  onApplied: (name: string) => void,
  onAdopted: (migration: AdoptedMigration) => void,
): Promise<void> {
  const table = quoteIdentifier(ledger.table)
  const insert = (name: string) => `INSERT INTO ${table} (name) VALUES ('${name.replaceAll("'", "''")}');`
  if (!ledger.exists || ledger.adopted.length) {
    await query([
      // Wrangler creates the same table.
      ...ledger.exists ? [] : [`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);`],
      ...ledger.adopted.map(migration => insert(migration.name)),
    ].join("\n"))
    for (const migration of ledger.adopted) onAdopted(migration)
  }
  for (const file of recordD1MigrationNames(migrationsDir)) {
    if (ledger.applied.has(file.name)) continue
    const sql = normalizeSqlLineEndings(readFileSync(file.source, "utf8"))
    await query(`${sql}\n;\n${insert(file.name)}`)
    onApplied(file.name)
  }
}

/** D1's statement splitter needs LF in compound SQL; quoted values and identifiers must retain their bytes. */
function normalizeSqlLineEndings(sql: string): string {
  let normalized = ""
  let quote: "'" | '"' | "`" | "]" | undefined
  let comment: "line" | "block" | undefined
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!
    const next = sql[index + 1]
    if (quote) {
      normalized += char
      if (char === quote) {
        if (next === quote) {
          normalized += next
          index++
        }
        else quote = undefined
      }
      continue
    }
    if (char === "\r" && next === "\n") {
      normalized += "\n"
      index++
      if (comment === "line") comment = undefined
      continue
    }
    normalized += char
    if (comment === "line") {
      if (char === "\n") comment = undefined
    }
    else if (comment === "block") {
      if (char === "*" && next === "/") {
        normalized += next
        index++
        comment = undefined
      }
    }
    else if ((char === "-" && next === "-") || (char === "/" && next === "*")) {
      normalized += next
      index++
      comment = char === "-" ? "line" : "block"
    }
    else if (char === "'" || char === '"' || char === "`") quote = char
    else if (char === "[") quote = "]"
  }
  return normalized
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`
}

function readD1Rows(payload: unknown): unknown[] | undefined {
  if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.result)) return
  if (payload.result.some(result => !isRecord(result) || result.success === false)) return
  const last: unknown = payload.result.at(-1)
  if (!isRecord(last)) return
  const rows = Array.isArray(last.results)
    ? last.results
    : isRecord(last.results) && Array.isArray(last.results.rows) ? last.results.rows : undefined
  if (!rows) return
  return rows.every(row => Array.isArray(row) || isRecord(row)) ? rows : undefined
}

function readRowValue(row: unknown, key: string, index: number): unknown {
  if (Array.isArray(row)) return row[index]
  return isRecord(row) ? row[key] : undefined
}

function describeD1Errors(payload: unknown): string {
  if (!isRecord(payload)) return ""
  const results = Array.isArray(payload.result) ? payload.result : []
  const messages = [...Array.isArray(payload.errors) ? payload.errors : [], ...results]
    .map(error => isRecord(error) ? (typeof error.message === "string" ? error.message : typeof error.error === "string" ? error.error : "") : "")
    .filter(Boolean)
  return messages.length ? `: ${messages.join("; ")}` : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]"
}
