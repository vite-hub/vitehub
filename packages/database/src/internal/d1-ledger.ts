import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { findRenumbered, matchLedger, matchRecordedNames, nameLedgerTables, toLedgerRow } from "./migration-ledger.ts"

import type { LedgerMigration, NamedMigration } from "./migration-ledger.ts"

// Wrangler's ledger on D1, without the file system: `vitehub database migrate` reads the migrations folder, and a server
// that migrates on start reads the migrations that its build shipped.

/** Wrangler's default ledger. `wrangler d1 migrations apply` and `vitehub database migrate` share it. */
export const defaultD1MigrationsTable = "d1_migrations"

/** The file that keeps the Wrangler name of each migration folder. See `listD1Migrations()`. */
export const d1MigrationNamesFile = "d1-migrations.json"

// Drizzle Kit's ledger. ViteHub used it for D1 HTTP before it used Wrangler's ledger.
const drizzleMigrationsTable = "__drizzle_migrations"

export type D1Query = (sql: string, params?: unknown[], mode?: "write") => Promise<unknown[]>

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
  /** Applied migrations that the Wrangler table does not list yet. They are recorded before the first migration runs. */
  adopted: readonly AdoptedMigration[]
  /** Whether the Wrangler table exists. */
  exists: boolean
  table: string
}

/**
 * Sends SQL to a D1 HTTP endpoint (the Cloudflare `/query` API or a proxy) and returns the rows of the last statement.
 * The SQL can hold several statements, which D1 runs as one batch. `fail` makes the caller's error for a problem.
 */
export function createD1QueryAt(url: string, token: string | undefined, fail: (problem: string) => Error, request: typeof fetch = fetch): D1Query {
  return async (sql, params = [], mode) => {
    const response = await request(url, {
      body: JSON.stringify({ params, sql }),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      method: "POST",
    })
    const payload: unknown = await response.json().catch(() => undefined)
    const rows = readD1Rows(payload, mode === "write")
    if (!response.ok || !rows) throw fail(`Cloudflare D1 returned HTTP ${response.status}${describeD1Errors(payload)}.`)
    return rows
  }
}

/**
 * Reads the applied migrations from Wrangler's migrations table and from the other ledgers on the database: NuxtHub's
 * `_hub_migrations`, Wrangler's default `d1_migrations`, and Drizzle Kit's `__drizzle_migrations`. A migration counts
 * as applied when a ledger lists its file name, its name without `.sql`, its folder, or the old file that its folder
 * keeps in its name, or, in Drizzle Kit's ledger, its SQL hash. So a database keeps its state after a move from
 * NuxtHub or a change of the migrations layout.
 *
 * `files` are the migrations with their Wrangler names, in Wrangler's order. `migrations` are the Drizzle Kit folders.
 */
export async function readD1LedgerOf(query: D1Query, migrationsTable: string, files: readonly NamedMigration[], migrations: readonly LedgerMigration[]): Promise<D1Ledger> {
  const nameTables = [migrationsTable, ...nameLedgerTables.filter(table => table !== migrationsTable)]
  const candidates = [...nameTables, drizzleMigrationsTable]
  const tables = new Set((await query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${candidates.map(() => "?").join(", ")})`, candidates))
    .map(row => readRowValue(row, "name", 0)))
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
 * request, so D1 rolls back both when the file fails. When a file fails because another process applied it first, the
 * ledger lists it, and this goes on with the next file.
 */
export async function applyD1MigrationFiles(
  query: D1Query,
  ledger: D1Ledger,
  files: ReadonlyArray<{ name: string, sql: () => string }>,
  onApplied: (name: string) => void,
  onAdopted: (migration: AdoptedMigration) => void,
): Promise<void> {
  const table = quoteIdentifier(ledger.table)
  const insert = (name: string) => `INSERT INTO ${table} (name) VALUES ('${name.replaceAll("'", "''")}');`
  if (!ledger.exists || ledger.adopted.length) {
    await query([
      // Wrangler creates the same table.
      ...ledger.exists ? [] : [`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);`],
      ...ledger.adopted.map(migration => `INSERT OR IGNORE INTO ${table} (name) VALUES ('${migration.name.replaceAll("'", "''")}');`),
    ].join("\n"), undefined, "write")
    for (const migration of ledger.adopted) onAdopted(migration)
  }
  for (const file of files) {
    if (ledger.applied.has(file.name)) continue
    try {
      await query(`${normalizeSqlLineEndings(file.sql())}\n;\n${insert(file.name)}`, undefined, "write")
    }
    catch (error) {
      if ((await query(`SELECT name FROM ${table} WHERE name = ?`, [file.name])).length) continue
      throw error
    }
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

function readD1Rows(payload: unknown, write: boolean): unknown[] | undefined {
  if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.result)) return
  if (payload.result.some(result => !isRecord(result) || result.success === false)) return
  const last: unknown = payload.result.at(-1)
  if (!isRecord(last)) return
  if (write && payload.result.every(result => isRecord(result) && result.success === true)
    && (last.results === undefined || (isRecord(last.results) && last.results.rows === undefined))) return []
  const rows = Array.isArray(last.results)
    ? last.results
    : isRecord(last.results) && Array.isArray(last.results.rows) ? last.results.rows : undefined
  if (!rows || !rows.every(row => Array.isArray(row) || isRecord(row))) return
  const columns = isRecord(last.results) ? last.results.columns : undefined
  if (!Array.isArray(columns) || !columns.length || !columns.every(column => typeof column === "string")) return rows
  return rows.map(row => Array.isArray(row) && row.length === columns.length ? Object.fromEntries(columns.map((column, index) => [column, row[index]])) : row)
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
