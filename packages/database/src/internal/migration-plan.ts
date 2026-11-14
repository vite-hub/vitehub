import { existsSync } from "node:fs"
import { createRequire } from "node:module"

import { createClient } from "@libsql/client"
import { join, resolve } from "pathe"

import { resolveConfigValue } from "../config-value.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { localPgliteDir, resolveLocalSqlitePath } from "../runtime/local-path.ts"
import { migratePostgres } from "../runtime/migrate-on-start.ts"
import { runsOnPglite } from "../runtime/postgres-env.ts"
import { applyD1Migrations, createD1Query, listD1Migrations, readD1Ledger } from "./d1-migrations.ts"
import { readStartMigrations } from "./migrate-on-start.ts"
import { readMigrations, readPendingMigration } from "./migration-journal.ts"
import { ledgerUpgradeProblem, matchLedger, toLedgerRow } from "./migration-ledger.ts"
import { withoutNewTableDataLoss } from "./migration-sql.ts"

import type postgres from "postgres"
import type { Result } from "@vite-hub/runtime"
import type { ResolvedDrizzleDatabaseConfig } from "../types.ts"
import type { D1HttpTarget } from "./d1-migrations.ts"
import type { LedgerRow } from "./migration-ledger.ts"
import type { PendingMigration } from "./migration-journal.ts"

export type { PendingMigration } from "./migration-journal.ts"

export interface MigrationPlan {
  database: string
  /** Where `vitehub database migrate` applies migrations, without credentials. */
  target: string
  /** How many migrations of the journal the database already has. */
  applied: number
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
  | { kind: "pglite", path: string }
  | { kind: "postgres", url?: string }

// Drizzle Kit uses these defaults because the generated config sets no `migrations` option. D1 HTTP uses Wrangler's ledger.
const sqliteMigrationsTable = "__drizzle_migrations"
const postgresMigrationsTable = "\"drizzle\".\"__drizzle_migrations\""

function resolveTarget(database: ResolvedDrizzleDatabaseConfig, { env, projectRoot }: MigrationPlanOptions): MigrationTarget | undefined {
  if (database.dialect === "postgresql") {
    const url = resolveConfigValue(database.connection?.url, env)?.trim() || undefined
    // Like the generated Kit config: PGlite for `driver: "pglite"`, or without a URL and PG* variables.
    if (runsOnPglite(database.driver, url, env)) return { kind: "pglite", path: resolve(projectRoot, localPgliteDir(database.name)) }
    return { kind: "postgres", url }
  }
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
      return `local SQLite ${withinProject(target.path, projectRoot)}`
    case "pglite":
      return `PGlite ${withinProject(target.path, projectRoot)}`
    case "postgres":
      return target.url ? `Postgres ${withoutCredentials(target.url)}` : "Postgres from the PG* environment variables"
  }
}

function withinProject(path: string, projectRoot: string) {
  return path.startsWith(`${projectRoot}/`) ? path.slice(projectRoot.length + 1) : path
}

export function withoutCredentials(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`
  }
  catch {
    return "(invalid URL)"
  }
}

/** Reads Drizzle's ledger. `SELECT *` reads a ledger of Drizzle Kit 0.x too, which has no `name` column. */
async function readLedgerRows(target: Exclude<MigrationTarget, { kind: "d1-http" }>, options: MigrationPlanOptions): Promise<LedgerRow[]> {
  switch (target.kind) {
    case "local": {
      // A missing file has no applied migrations. Do not let libSQL create it.
      if (!existsSync(target.path)) return []
      return await readSqliteLedger(`file:${target.path}`)
    }
    case "libsql":
      return await readSqliteLedger(target.url, target.authToken)
    case "pglite":
      return await readPgliteLedger(target.path, options.projectRoot)
    case "postgres":
      return await readPostgresLedger(target, options.projectRoot, options.env)
  }
}

async function readSqliteLedger(url: string, authToken?: string): Promise<LedgerRow[]> {
  const client = createClient({ authToken, url })
  try {
    const table = await client.execute({ args: [sqliteMigrationsTable], sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?" })
    if (!table.rows.length) return []
    const result = await client.execute(`SELECT * FROM ${sqliteMigrationsTable}`)
    return result.rows.map(row => toLedgerRow({ ...row }))
  }
  finally {
    client.close()
  }
}

/** Opens a postgres.js client for the CLI with `connection.url` or the PG* variables, like the generated Kit config. */
export function connectPostgres(target: { url?: string }, projectRoot: string, env: NodeJS.ProcessEnv): postgres.Sql {
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
  return target.url ? connect(target.url, options) : connect(options)
}

async function readPostgresLedger(target: Extract<MigrationTarget, { kind: "postgres" }>, projectRoot: string, env: NodeJS.ProcessEnv): Promise<LedgerRow[]> {
  const sql = connectPostgres(target, projectRoot, env)
  try {
    const [table] = await sql<Array<{ name: string | null }>>`select to_regclass('drizzle.__drizzle_migrations')::text as name`
    if (!table?.name) return []
    const rows = await sql.unsafe<Array<Record<string, unknown>>>(`select * from ${postgresMigrationsTable}`)
    return rows.map(row => toLedgerRow(row))
  }
  finally {
    await sql.end({ timeout: 5 })
  }
}

async function readPgliteLedger(path: string, projectRoot: string): Promise<LedgerRow[]> {
  let PGlite: typeof import("@electric-sql/pglite").PGlite
  try {
    // Drizzle Kit loads PGlite from the project too.
    ({ PGlite } = createRequire(join(projectRoot, "package.json"))("@electric-sql/pglite") as typeof import("@electric-sql/pglite"))
  }
  catch (error) {
    // Check it before the folder exists too: Drizzle Kit needs it to apply the first migration.
    throw new Error("It runs on PGlite, because the Definition sets `driver: \"pglite\"` or has no `connection.url` and no PG* variables, but the project cannot load `@electric-sql/pglite`. Set `connection.url` to migrate a Postgres server, or install PGlite with `pnpm add -D @electric-sql/pglite`.", { cause: error })
  }
  // A missing folder has no applied migrations. Do not let PGlite create it.
  if (!existsSync(path)) return []
  const client = new PGlite(path)
  try {
    const { rows: [table] } = await client.query<{ name: string | null }>("select to_regclass('drizzle.__drizzle_migrations')::text as name")
    if (!table?.name) return []
    const { rows } = await client.query<Record<string, unknown>>(`select * from ${postgresMigrationsTable}`)
    return rows.map(row => toLedgerRow(row))
  }
  finally {
    await client.close()
  }
}

/**
 * Lists the migrations that `vitehub database migrate` would apply to one database, with their statements that lose data.
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
    const entries = readMigrations(database.migrationsDir, database.name)
    if (target.kind === "d1-http") {
      const ledger = await readD1Ledger(createD1Query(target, options.fetch), database, entries)
      const pending = listD1Migrations(database.migrationsDir)
        .filter(file => !ledger.applied.has(file.name))
        .map(file => readPendingMigration(database.migrationsDir, file.tag, entries))
      return [undefined, { applied: ledger.applied.size, database: database.name, pending: withoutNewTableDataLoss(pending), target: describeTarget(target, options.projectRoot) }]
    }
    // Drizzle 1.0 applies each migration folder whose name the ledger does not list.
    const match = matchLedger(entries.length ? await readLedgerRows(target, options) : [], entries)
    const problem = ledgerUpgradeProblem(match)
    if (problem) return [databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ database: database.name, problem }), undefined]
    const { applied, unmatched } = match
    // Drizzle 1.0 adds `name` to a Drizzle Kit 0.x ledger first, and refuses rows that match no migration folder, for
    // example the rows of another Definition on the same database.
    if (unmatched.length) {
      const problem = `Its Drizzle Kit 0.x migrations table has ${unmatched.length} row(s) (id ${unmatched.join(", ")}) that match no migration folder in ${database.migrationsDir}, so Drizzle 1.0 cannot upgrade it. Restore the missing folders, or give each Definition its own database.`
      return [databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ database: database.name, problem }), undefined]
    }
    const pending = entries
      .filter(entry => !applied.has(entry.tag))
      .map(entry => readPendingMigration(database.migrationsDir, entry.tag, entries))
    return [undefined, { applied: entries.length - pending.length, database: database.name, pending: withoutNewTableDataLoss(pending, database.dialect), target: describeTarget(target, options.projectRoot) }]
  }
  catch (error) {
    const problem = error instanceof Error ? error.message : String(error)
    return [databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ cause: error, database: database.name, problem }), undefined]
  }
}

/**
 * Applies the pending migrations of a D1 HTTP database with Wrangler's ledger, so `wrangler d1 migrations apply` and
 * `vitehub database migrate` agree on what is applied. Returns the error message when a request fails.
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
    const ledger = await readD1Ledger(query, database, readMigrations(database.migrationsDir, database.name))
    await applyD1Migrations(query, ledger, database.migrationsDir, onApplied)
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Applies the pending migrations of the Postgres databases with the runtime's `migratePostgres()`, the one that a server
 * runs on start. It holds the same advisory lock, so `vitehub database migrate` and a starting server never migrate at the
 * same time, and Definitions on one Postgres database migrate together. Returns the error when the migrations do not apply.
 */
export async function migratePostgresDatabases(
  databases: ResolvedDrizzleDatabaseConfig[],
  options: MigrationPlanOptions & { allowDataLoss: boolean },
  log: (message: string) => void,
): Promise<unknown> {
  const clients: postgres.Sql[] = []
  try {
    const targets = databases.map((database) => {
      const target = resolveTarget(database, options)
      // Internal invariant: the CLI passes only Definitions filtered by their Postgres dialect.
      if (target?.kind !== "postgres") throw new Error(`The database "${database.name}" is not a Postgres database.`)
      const client = connectPostgres(target, options.projectRoot, options.env)
      clients.push(client)
      return { client, database: { migrations: readStartMigrations(database.migrationsDir), name: database.name } }
    })
    await migratePostgres(targets, { allowDataLoss: options.allowDataLoss, log })
  }
  catch (error) {
    return error
  }
  finally {
    await Promise.all(clients.map(client => client.end({ timeout: 5 })))
  }
}
