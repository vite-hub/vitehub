import { existsSync, readdirSync, readFileSync } from "node:fs"
import { copyFile, mkdir } from "node:fs/promises"

import { join } from "pathe"

import { matchLedger, toLedgerRow } from "./migration-ledger.ts"

import type { MigrationEntry } from "./migration-journal.ts"

/** Wrangler's default ledger. `wrangler d1 migrations apply` and `vitehub db migrate` share it. */
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

export interface D1Ledger {
  /** Migration file names in the ledger. */
  applied: ReadonlySet<string>
  /**
   * Set when the ledger table does not exist yet. Names of the migrations that Drizzle Kit applied before, which the
   * first `vitehub db migrate` writes into the new ledger.
   */
  missing?: { adopted: readonly string[] }
  table: string
}

/** Sends SQL to the Cloudflare D1 HTTP API or a configured proxy. Returns the rows of the last statement. */
export function createD1Query(target: D1HttpTarget, request: typeof fetch = fetch): D1Query {
  const missing = (target.proxy ? [
    !target.proxy.url && "`cloudflare.http.url`",
    !target.proxy.token && "`cloudflare.http.authToken`",
  ] : [
    !target.accountId && "`CLOUDFLARE_ACCOUNT_ID`",
    !target.token && "`CLOUDFLARE_API_TOKEN`",
    !target.databaseId && "a value for `cloudflare.databaseId`",
  ]).filter(Boolean)
  if (missing.length) throw new Error(`ViteHub applies D1 HTTP migrations with ${target.proxy ? "the configured proxy" : "the Cloudflare API"}, which needs ${missing.join(" and ")}.`)
  const url = target.proxy
    ? target.proxy.url!
    : `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(target.accountId!)}/d1/database/${encodeURIComponent(target.databaseId!)}/query`
  if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("D1 HTTP migrations need an HTTP or HTTPS URL for `cloudflare.http.url`.")
  const token = target.proxy ? target.proxy.token : target.token
  return async (sql, params = []) => {
    const response = await request(url, {
      body: JSON.stringify({ params, sql }),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      method: "POST",
    })
    const payload: unknown = await response.json().catch(() => undefined)
    const rows = readD1Rows(payload)
    if (!response.ok || !rows) throw new Error(`Cloudflare D1 returned HTTP ${response.status}${describeD1Errors(payload)}.`)
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
 * Lists the migrations of a directory with the `.sql` file names that Wrangler applies, in Wrangler's order.
 *
 * A Drizzle Kit folder gets the name that Drizzle Kit 0.x gave the same migration: `NNNN_<name>.sql`, numbered by the
 * folder order. `drizzle-kit up` keeps that order and name, so a converted migration keeps its row in Wrangler's
 * `d1_migrations`, and Wrangler does not apply it again. A flat `.sql` file, such as one from
 * `wrangler d1 migrations create`, keeps its name.
 */
export function listD1Migrations(migrationsDir: string): D1MigrationFile[] {
  if (!existsSync(migrationsDir)) return []
  const entries = readdirSync(migrationsDir, { withFileTypes: true })
  const folders = entries
    .filter(entry => entry.isDirectory() && existsSync(join(migrationsDir, entry.name, "migration.sql")))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))
  const files: D1MigrationFile[] = folders.map((tag, index) => ({
    name: `${String(index).padStart(4, "0")}_${folderTag.exec(tag)?.[1] ?? tag}.sql`,
    source: join(migrationsDir, tag, "migration.sql"),
    tag,
  }))
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue
    const folder = files.find(file => file.name === entry.name)
    if (folder) {
      throw new Error(`${join(migrationsDir, entry.name)} has the Wrangler name of the migration folder ${folder.tag}. Rename the file, for example with the next free number.`)
    }
    files.push({ name: entry.name, source: join(migrationsDir, entry.name), tag: entry.name.slice(0, -".sql".length) })
  }
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

/** Writes the migrations of `migrationsDir` into `outputDir` as the flat `.sql` files that Wrangler reads from `migrations_dir`. */
export async function copyD1MigrationFiles(migrationsDir: string, outputDir: string): Promise<void> {
  const files = listD1Migrations(migrationsDir)
  await mkdir(outputDir, { recursive: true })
  await Promise.all(files.map(file => copyFile(file.source, join(outputDir, file.name))))
}

/**
 * Fails when a ledger row has the name part of a migration under another number. The numbers follow the folder order,
 * so a folder that sorts before applied ones renumbers them, and Wrangler would apply them again.
 */
function assertNumbering(applied: ReadonlySet<string>, files: readonly D1MigrationFile[]) {
  const names = new Set(files.map(file => file.name))
  for (const name of applied) {
    if (names.has(name)) continue
    const suffix = /^\d+_(.+)$/.exec(name)?.[1]
    const moved = suffix && files.find(file => file.name.endsWith(`_${suffix}`))
    if (moved) {
      throw new Error(`Wrangler's migrations table lists ${name}, but that migration is now ${moved.name} (${moved.tag}). A migration folder sorts before migrations that are already applied, so Wrangler would apply them again. Give the new folder a later timestamp.`)
    }
  }
}

/**
 * Reads Wrangler's migrations ledger. When it does not exist and Drizzle Kit's ledger does, the migrations that
 * Drizzle Kit applied count as applied, so a database that `vitehub db migrate` migrated before keeps its state.
 */
export async function readD1Ledger(
  query: D1Query,
  { cloudflare, migrationsDir }: { cloudflare?: { migrationsTable?: string }, migrationsDir: string },
  migrations: readonly MigrationEntry[],
): Promise<D1Ledger> {
  const migrationsTable = cloudflare?.migrationsTable ?? defaultD1MigrationsTable
  const tables = new Set((await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)", [migrationsTable, drizzleMigrationsTable]))
    .map(row => readRowValue(row, "name", 0)))
  if (tables.has(migrationsTable)) {
    const rows = await query(`SELECT name FROM ${quoteIdentifier(migrationsTable)}`)
    const applied = new Set(rows.map(row => String(readRowValue(row, "name", 0))))
    assertNumbering(applied, listD1Migrations(migrationsDir))
    return { applied, table: migrationsTable }
  }
  let adopted: string[] = []
  if (tables.has(drizzleMigrationsTable)) {
    // ViteHub wrote this ledger as Drizzle Kit 0.x did, without `name`, so rows match by time and hash.
    const rows = await query(`SELECT id, hash, created_at FROM ${drizzleMigrationsTable}`)
    const { applied } = matchLedger(rows.map(row => toLedgerRow({
      created_at: readRowValue(row, "created_at", 2),
      hash: readRowValue(row, "hash", 1),
      id: readRowValue(row, "id", 0),
    })), migrations)
    adopted = listD1Migrations(migrationsDir).filter(file => applied.has(file.tag)).map(file => file.name)
  }
  return { applied: new Set(adopted), missing: { adopted }, table: migrationsTable }
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
): Promise<void> {
  const table = quoteIdentifier(ledger.table)
  const insert = (name: string) => `INSERT INTO ${table} (name) VALUES ('${name.replaceAll("'", "''")}');`
  if (ledger.missing) {
    // Wrangler creates the same table.
    await query([
      `CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);`,
      ...ledger.missing.adopted.map(insert),
    ].join("\n"))
  }
  for (const file of listD1Migrations(migrationsDir)) {
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
