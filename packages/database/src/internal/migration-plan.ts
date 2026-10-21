import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"

import { createClient } from "@libsql/client"
import { join, resolve } from "pathe"

import { resolveConfigValue } from "../config-value.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { resolveLocalSqlitePath } from "../runtime/local-path.ts"
import { findDataLoss } from "./migration-sql.ts"

import type postgres from "postgres"
import type { Result } from "@vite-hub/runtime"
import type { ResolvedDrizzleDatabaseConfig } from "../types.ts"
import type { DataLossStatement, TableColumns } from "./migration-sql.ts"

/** A migration in the migrations folder that the database has not applied. */
export interface PendingMigration {
  dataLoss: DataLossStatement[]
  name: string
  statements: string[]
}

export interface MigrationPlan {
  database: string
  /** Where `vitehub db migrate` applies migrations, without credentials. */
  target: string
  pending: PendingMigration[]
}

export type MigrationPlanErrorCode = "DATABASE_MIGRATION_CHECK_FAILED"

export interface MigrationPlanOptions {
  env: NodeJS.ProcessEnv
  fetch?: typeof fetch
  projectRoot: string
}

interface JournalEntry {
  idx: number
  tag: string
  when: number
}

/** The connection that the generated Drizzle Kit config uses. Keep it in sync with `renderDbCredentials()`. */
type MigrationTarget =
  | { kind: "d1-http", accountId?: string, databaseId?: string, token?: string }
  | { kind: "libsql", authToken?: string, url: string }
  | { kind: "local", path: string }
  | { kind: "postgres", url?: string }

// Drizzle Kit uses these defaults because the generated config sets no `migrations` option.
const sqliteMigrationsTable = "__drizzle_migrations"
const postgresMigrationsTable = "\"drizzle\".\"__drizzle_migrations\""

function resolveTarget(database: ResolvedDrizzleDatabaseConfig, { env, projectRoot }: MigrationPlanOptions): MigrationTarget | undefined {
  if (database.dialect === "postgresql") return { kind: "postgres", url: resolveConfigValue(database.connection?.url, env)?.trim() || undefined }
  if (database.cloudflare?.http && database.cloudflare.databaseId !== undefined) {
    return {
      accountId: env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined,
      databaseId: resolveConfigValue(database.cloudflare.databaseId, env)?.trim() || undefined,
      kind: "d1-http",
      token: env.CLOUDFLARE_API_TOKEN?.trim() || undefined,
    }
  }
  const url = resolveConfigValue(database.connection?.url, env)?.trim()
  if (!url) return
  if (/^(?:libsql:|https?:|wss?:)/i.test(url)) return { authToken: resolveConfigValue(database.connection?.authToken, env), kind: "libsql", url }
  if (isMemorySqliteUrl(url)) return
  return { kind: "local", path: resolve(projectRoot, resolveLocalSqlitePath(url)) }
}

function isMemorySqliteUrl(url: string): boolean {
  return url === ":memory:"
    || /^file:(?::memory:|memory:|\/\/(?:localhost\/)?(?::memory:|memory:))/i.test(url)
}

function describeTarget(target: MigrationTarget, projectRoot: string): string {
  switch (target.kind) {
    case "d1-http":
      return `Cloudflare D1 ${target.databaseId ?? "(no database id)"} over HTTP`
    case "libsql":
      return `libSQL ${withoutCredentials(target.url)}`
    case "local":
      return `local SQLite ${target.path.startsWith(`${projectRoot}/`) ? target.path.slice(projectRoot.length + 1) : target.path}`
    case "postgres":
      return target.url ? `Postgres ${withoutCredentials(target.url)}` : "Postgres from the PG* environment variables"
  }
}

function withoutCredentials(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`
  }
  catch {
    return "(invalid URL)"
  }
}

/** Reads `created_at` of the last applied migration, the value that Drizzle compares with each journal `when`. */
async function readLastAppliedMillis(target: MigrationTarget, options: MigrationPlanOptions): Promise<number | undefined> {
  switch (target.kind) {
    case "local": {
      // A missing file has no applied migrations. Do not let libSQL create it.
      if (!existsSync(target.path)) return
      return await readSqliteLastApplied(`file:${target.path}`)
    }
    case "libsql":
      return await readSqliteLastApplied(target.url, target.authToken)
    case "d1-http":
      return await readD1LastApplied(target, options.fetch ?? fetch)
    case "postgres":
      return await readPostgresLastApplied(target, options.projectRoot)
  }
}

async function readSqliteLastApplied(url: string, authToken?: string): Promise<number | undefined> {
  const client = createClient({ authToken, url })
  try {
    const table = await client.execute({ args: [sqliteMigrationsTable], sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?" })
    if (!table.rows.length) return
    const result = await client.execute(`SELECT created_at FROM ${sqliteMigrationsTable} ORDER BY created_at DESC LIMIT 1`)
    return toMillis(result.rows[0]?.[0])
  }
  finally {
    client.close()
  }
}

async function readD1LastApplied(target: Extract<MigrationTarget, { kind: "d1-http" }>, request: typeof fetch): Promise<number | undefined> {
  const missing = [
    !target.accountId && "`CLOUDFLARE_ACCOUNT_ID`",
    !target.token && "`CLOUDFLARE_API_TOKEN`",
    !target.databaseId && "a value for `cloudflare.databaseId`",
  ].filter(Boolean)
  if (missing.length) throw new Error(`Drizzle Kit applies D1 HTTP migrations with the Cloudflare API, which needs ${missing.join(" and ")}.`)
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(target.accountId!)}/d1/database/${encodeURIComponent(target.databaseId!)}/raw`
  const query = async (sql: string, params: unknown[] = []) => {
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
  const table = await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [sqliteMigrationsTable])
  if (!table.length) return
  const rows = await query(`SELECT created_at FROM ${sqliteMigrationsTable} ORDER BY created_at DESC LIMIT 1`)
  return toMillis(readRowValue(rows[0], "created_at", 0))
}

function readD1Rows(payload: unknown): unknown[] | undefined {
  if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.result)) return
  const first: unknown = payload.result[0]
  if (!isRecord(first)) return
  const rows = Array.isArray(first.results)
    ? first.results
    : isRecord(first.results) && Array.isArray(first.results.rows) ? first.results.rows : undefined
  if (!rows) return
  return Array.isArray(rows) && rows.every(row => Array.isArray(row) || isRecord(row)) ? rows : undefined
}

function readRowValue(row: unknown, key: string, index: number): unknown {
  if (Array.isArray(row)) return row[index]
  return isRecord(row) ? row[key] : undefined
}

function describeD1Errors(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.errors)) return ""
  const messages = payload.errors.map(error => isRecord(error) && typeof error.message === "string" ? error.message : "").filter(Boolean)
  return messages.length ? `: ${messages.join("; ")}` : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]"
}

async function readPostgresLastApplied(target: Extract<MigrationTarget, { kind: "postgres" }>, projectRoot: string): Promise<number | undefined> {
  let connect: typeof postgres
  try {
    // The app installs the Postgres driver, so load it from the project, like Drizzle Kit does.
    connect = createRequire(join(projectRoot, "package.json"))("postgres")
  }
  catch (error) {
    throw new Error("Cannot load the `postgres` package from the project. Install it, for example with `pnpm add postgres`.", { cause: error })
  }
  const options = { connect_timeout: 10, max: 1, onnotice: () => {} }
  const sql = target.url ? connect(target.url, options) : connect(options)
  try {
    const [table] = await sql<Array<{ name: string | null }>>`select to_regclass('drizzle.__drizzle_migrations')::text as name`
    if (!table?.name) return
    const [last] = await sql.unsafe<Array<{ created_at: unknown }>>(`select created_at from ${postgresMigrationsTable} order by created_at desc limit 1`)
    return toMillis(last?.created_at)
  }
  finally {
    await sql.end({ timeout: 5 })
  }
}

function toMillis(value: unknown): number | undefined {
  if (value === null || value === undefined) return
  const millis = Number(value)
  return Number.isFinite(millis) ? millis : undefined
}

function readJournal(migrationsDir: string): JournalEntry[] {
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

/**
 * Lists the migrations that `vitehub db migrate` would apply to one database, with their statements that lose data.
 * It reads the Drizzle migrations table and changes nothing.
 */
export async function readMigrationPlan(
  database: ResolvedDrizzleDatabaseConfig,
  options: MigrationPlanOptions,
): Promise<Result<MigrationPlan, MigrationPlanErrorCode>> {
  const target = resolveTarget(database, options)
  if (!target) {
    const url = resolveConfigValue(database.connection?.url, options.env)?.trim()
    const problem = url
      ? "It uses an in-memory SQLite URL, which a separate migration process cannot inspect. Use a file-backed SQLite URL."
      : "It has no `connection.url`."
    return [databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ database: database.name, problem }), undefined]
  }
  try {
    const entries = readJournal(database.migrationsDir)
    const lastApplied = entries.length ? await readLastAppliedMillis(target, options) : undefined
    const pending = entries
      .filter(entry => lastApplied === undefined || lastApplied < entry.when)
      .map((entry) => {
        const sql = readFileSync(join(database.migrationsDir, `${entry.tag}.sql`), "utf8")
        const statements = sql.split("--> statement-breakpoint").map(statement => statement.trim()).filter(Boolean)
        const before = entry.idx > 0 ? readSnapshotColumns(database.migrationsDir, entry.idx - 1) : new Map<string, string[]>()
        return { dataLoss: findDataLoss(statements, before), name: entry.tag, statements }
      })
    return [undefined, { database: database.name, pending, target: describeTarget(target, options.projectRoot) }]
  }
  catch (error) {
    const problem = error instanceof Error ? error.message : String(error)
    return [databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ cause: error, database: database.name, problem }), undefined]
  }
}
