import { existsSync, readdirSync, readFileSync } from "node:fs"

import { join } from "pathe"

/** Wrangler's default ledger. `wrangler d1 migrations apply` and `vitehub db migrate` share it. */
export const defaultD1MigrationsTable = "d1_migrations"

// Drizzle Kit's ledger. ViteHub used it for D1 HTTP before it used Wrangler's ledger.
const drizzleMigrationsTable = "__drizzle_migrations"

export interface D1HttpTarget {
  accountId?: string
  databaseId?: string
  token?: string
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

/** Sends SQL to the Cloudflare D1 HTTP API. Returns the rows of the last statement. */
export function createD1Query(target: D1HttpTarget, request: typeof fetch = fetch): D1Query {
  const missing = [
    !target.accountId && "`CLOUDFLARE_ACCOUNT_ID`",
    !target.token && "`CLOUDFLARE_API_TOKEN`",
    !target.databaseId && "a value for `cloudflare.databaseId`",
  ].filter(Boolean)
  if (missing.length) throw new Error(`ViteHub applies D1 HTTP migrations with the Cloudflare API, which needs ${missing.join(" and ")}.`)
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(target.accountId!)}/d1/database/${encodeURIComponent(target.databaseId!)}/query`
  return async (sql, params = []) => {
    const response = await request(url, {
      body: JSON.stringify({ params, sql }),
      headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/json" },
      method: "POST",
    })
    const payload: unknown = await response.json().catch(() => undefined)
    const rows = readD1Rows(payload)
    if (!response.ok || !rows) throw new Error(`Cloudflare D1 returned HTTP ${response.status}${describeD1Errors(payload)}.`)
    return rows
  }
}

/** Lists the `.sql` files of a migrations directory in the order that Wrangler applies them. */
export function listD1MigrationFiles(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) return []
  return readdirSync(migrationsDir).filter(name => name.endsWith(".sql")).sort()
}

/**
 * Reads Wrangler's migrations ledger. When it does not exist and Drizzle Kit's ledger does, the journal entries that
 * Drizzle Kit applied count as applied, so a database that `vitehub db migrate` migrated before keeps its state.
 */
export async function readD1Ledger(
  query: D1Query,
  { cloudflare, migrationsDir }: { cloudflare?: { migrationsTable?: string }, migrationsDir: string },
  journal: ReadonlyArray<{ tag: string, when: number }>,
): Promise<D1Ledger> {
  const migrationsTable = cloudflare?.migrationsTable ?? defaultD1MigrationsTable
  const tables = new Set((await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)", [migrationsTable, drizzleMigrationsTable]))
    .map(row => readRowValue(row, "name", 0)))
  if (tables.has(migrationsTable)) {
    const rows = await query(`SELECT name FROM ${quoteIdentifier(migrationsTable)}`)
    return { applied: new Set(rows.map(row => String(readRowValue(row, "name", 0)))), table: migrationsTable }
  }
  let adopted: string[] = []
  if (tables.has(drizzleMigrationsTable)) {
    const [last] = await query(`SELECT created_at FROM ${drizzleMigrationsTable} ORDER BY created_at DESC LIMIT 1`)
    const lastApplied = Number(readRowValue(last, "created_at", 0))
    const files = new Set(listD1MigrationFiles(migrationsDir))
    adopted = journal.filter(entry => entry.when <= lastApplied).map(entry => `${entry.tag}.sql`).filter(name => files.has(name))
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
  for (const name of listD1MigrationFiles(migrationsDir)) {
    if (ledger.applied.has(name)) continue
    await query(`${readFileSync(join(migrationsDir, name), "utf8")}\n;\n${insert(name)}`)
    onApplied(name)
  }
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
