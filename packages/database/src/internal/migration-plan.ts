import { existsSync } from "node:fs"
import { createRequire } from "node:module"

import { createClient } from "@libsql/client"
import { join, resolve } from "pathe"

import { resolveConfigValue } from "../config-value.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { resolveLocalSqlitePath } from "../runtime/local-path.ts"
import { applyD1Migrations, createD1Query, listD1MigrationFiles, readD1Ledger } from "./d1-migrations.ts"
import { readJournal, readPendingMigration } from "./migration-journal.ts"

import type postgres from "postgres"
import type { Result } from "@vite-hub/runtime"
import type { ResolvedDrizzleDatabaseConfig } from "../types.ts"
import type { D1HttpTarget } from "./d1-migrations.ts"
import type { PendingMigration } from "./migration-journal.ts"

export type { PendingMigration } from "./migration-journal.ts"

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

/** D1 HTTP uses the runtime's API or proxy target; other connections follow `renderDbCredentials()`. */
type MigrationTarget =
  | ({ kind: "d1-http" } & D1HttpTarget)
  | { kind: "libsql", authToken?: string, url: string }
  | { kind: "local", path: string }
  | { kind: "postgres", url?: string }

// Drizzle Kit uses these defaults because the generated config sets no `migrations` option. D1 HTTP uses Wrangler's ledger.
const sqliteMigrationsTable = "__drizzle_migrations"
const postgresMigrationsTable = "\"drizzle\".\"__drizzle_migrations\""

function resolveTarget(database: ResolvedDrizzleDatabaseConfig, { env, projectRoot }: MigrationPlanOptions): MigrationTarget | undefined {
  if (database.dialect === "postgresql") return { kind: "postgres", url: resolveConfigValue(database.connection?.url, env)?.trim() || undefined }
  if (database.cloudflare?.http && database.cloudflare.databaseId !== undefined) {
    const http = database.cloudflare.http
    return {
      accountId: env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined,
      databaseId: resolveConfigValue(database.cloudflare.databaseId, env)?.trim() || undefined,
      kind: "d1-http",
      token: env.CLOUDFLARE_API_TOKEN?.trim() || undefined,
      ...(http === true ? {} : { proxy: {
        token: resolveConfigValue(http.authToken, env)?.trim() || undefined,
        url: resolveConfigValue(http.url, env)?.trim() || undefined,
      } }),
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
      return target.proxy
        ? `D1 HTTP proxy ${withoutCredentials(target.proxy.url ?? "")}`
        : `Cloudflare D1 ${target.databaseId ?? "(no database id)"} over HTTP`
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
async function readLastAppliedMillis(target: Exclude<MigrationTarget, { kind: "d1-http" }>, options: MigrationPlanOptions): Promise<number | undefined> {
  switch (target.kind) {
    case "local": {
      // A missing file has no applied migrations. Do not let libSQL create it.
      if (!existsSync(target.path)) return
      return await readSqliteLastApplied(`file:${target.path}`)
    }
    case "libsql":
      return await readSqliteLastApplied(target.url, target.authToken)
    case "postgres":
      return await readPostgresLastApplied(target, options.projectRoot, options.env)
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

async function readPostgresLastApplied(target: Extract<MigrationTarget, { kind: "postgres" }>, projectRoot: string, env: NodeJS.ProcessEnv): Promise<number | undefined> {
  let connect: typeof postgres
  try {
    // The app installs the Postgres driver, so load it from the project, like Drizzle Kit does.
    connect = createRequire(join(projectRoot, "package.json"))("postgres")
  }
  catch (error) {
    throw new Error("Cannot load the `postgres` package from the project. Install it, for example with `pnpm add postgres`.", { cause: error })
  }
  const options = {
    connect_timeout: 10,
    database: env.PGDATABASE,
    host: env.PGHOST,
    max: 1,
    onnotice: () => {},
    password: env.PGPASSWORD,
    port: env.PGPORT ? Number(env.PGPORT) : undefined,
    user: env.PGUSERNAME ?? env.PGUSER,
  }
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

/**
 * Lists the migrations that `vitehub db migrate` would apply to one database, with their statements that lose data.
 * It reads the Drizzle migrations table, or Wrangler's `d1_migrations` table for D1 HTTP, and changes nothing.
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
    if (target.kind === "d1-http") {
      const ledger = await readD1Ledger(createD1Query(target, options.fetch), database, entries)
      const pending = listD1MigrationFiles(database.migrationsDir)
        .filter(file => !ledger.applied.has(file))
        .map(file => readPendingMigration(database.migrationsDir, file.slice(0, -".sql".length), entries))
      return [undefined, { database: database.name, pending, target: describeTarget(target, options.projectRoot) }]
    }
    const lastApplied = entries.length ? await readLastAppliedMillis(target, options) : undefined
    const pending = entries
      .filter(entry => lastApplied === undefined || lastApplied < entry.when)
      .map(entry => readPendingMigration(database.migrationsDir, entry.tag, entries))
    return [undefined, { database: database.name, pending, target: describeTarget(target, options.projectRoot) }]
  }
  catch (error) {
    const problem = error instanceof Error ? error.message : String(error)
    return [databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ cause: error, database: database.name, problem }), undefined]
  }
}

/**
 * Applies the pending migrations of a D1 HTTP database with Wrangler's ledger, so `wrangler d1 migrations apply` and
 * `vitehub db migrate` agree on what is applied. Returns the error message when a request fails.
 */
export async function migrateD1Http(
  database: ResolvedDrizzleDatabaseConfig,
  options: MigrationPlanOptions,
  onApplied: (name: string) => void,
): Promise<string | undefined> {
  const target = resolveTarget(database, options)
  if (target?.kind !== "d1-http") return `The database "${database.name}" does not use D1 HTTP.`
  try {
    const query = createD1Query(target, options.fetch)
    const ledger = await readD1Ledger(query, database, readJournal(database.migrationsDir))
    await applyD1Migrations(query, ledger, database.migrationsDir, onApplied)
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
