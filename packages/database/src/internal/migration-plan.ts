import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"

import { createClient } from "@libsql/client"
import { dirname, join, resolve } from "pathe"

import { resolveConfigValue } from "../config-value.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { localPgliteDir, resolveLocalSqlitePath } from "../runtime/local-path.ts"
import { migratePostgres, toPgliteMigrationClient, toPostgresMigrationClient } from "../runtime/migrate-on-start.ts"
import { runsOnPglite } from "../runtime/postgres-env.ts"
import { invariantError } from "@vite-hub/internal/invariant"

import { applyD1Migrations, createD1Query, d1MigrationNamesFile, listD1Migrations, readD1Ledger } from "./d1-migrations.ts"
import { readStartMigrations } from "./migrate-on-start.ts"
import { migrationSqlFile, readMigrations, readPendingMigration } from "./migration-journal.ts"
import { findRenumbered, ledgerUpgradeProblem, ledgerUpgradeStatements, matchLedger, matchRecordedNames, matchRenamedRows, nameLedgerTables, toLedgerRow } from "./migration-ledger.ts"
import { addStatementBreakpoints, migrationParts, withoutNewTableDataLoss } from "./migration-sql.ts"

import type postgres from "postgres"
import type { Result } from "@vite-hub/runtime"
import type { ResolvedDrizzleDatabaseConfig } from "../types.ts"
import type { D1HttpTarget } from "./d1-migrations.ts"
import type { PostgresMigrationClient, PostgresMigrationSql, PostgresTarget } from "../runtime/migrate-on-start.ts"
import type { LedgerMatch, LedgerRow } from "./migration-ledger.ts"
import type { MigrationEntry, PendingMigration } from "./migration-journal.ts"

export type { PendingMigration } from "./migration-journal.ts"

export interface MigrationPlan {
  database: string
  /** Where `vitehub database migrate` applies migrations, without credentials. */
  target: string
  /** How many migrations of the journal the database already has. */
  applied: number
  /**
   * Applied migrations that only another ledger lists, such as NuxtHub's `_hub_migrations`, or a renamed folder in
   * Drizzle's ledger. `vitehub database migrate` records them in the ledger that it uses, and does not run them.
   */
  adopted: AdoptedMigration[]
  pending: PendingMigration[]
}

/** An applied migration that `vitehub database migrate` takes from another ledger. */
export interface AdoptedMigration {
  /** The ledger table that lists it. */
  from: string
  /** The migration folder, or the flat file name without `.sql`. */
  name: string
}

export type MigrationPlanErrorCode = "DATABASE_MIGRATION_CHECK_FAILED"

/** Makes `DATABASE_MIGRATION_CHECK_FAILED` for one database. */
type CheckFailure = (problem: string, cause?: unknown) => Error

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
const createSqliteMigrationsTable = `CREATE TABLE IF NOT EXISTS ${sqliteMigrationsTable} (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`
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
async function readLedgerRows(target: Extract<MigrationTarget, { kind: "pglite" | "postgres" }>, options: MigrationPlanOptions, fail: CheckFailure, driver?: string): Promise<LedgerRow[]> {
  switch (target.kind) {
    case "pglite":
      return await readPgliteLedger(target.path, options.projectRoot, fail)
    case "postgres":
      return await readPostgresLedger(target, options, driver)
  }
}

/** The migration ledgers of a SQLite or libSQL database. */
interface SqliteLedgers {
  /** Drizzle's ledger, and whether it has the `name` column of Drizzle 1.0. Unset when the table does not exist. */
  drizzle?: { named: boolean, rows: LedgerRow[] }
  /** The names in each ledger of another tool, such as NuxtHub's `_hub_migrations` or Wrangler's `d1_migrations`. */
  recorded: Array<{ names: string[], table: string }>
}

/** The ledgers of other tools that `vitehub database migrate` reads on SQLite and libSQL, and `cloudflare.migrationsTable`. */
function recordedLedgerTables(database: ResolvedDrizzleDatabaseConfig): string[] {
  return [...new Set([...nameLedgerTables, ...database.cloudflare?.migrationsTable ? [database.cloudflare.migrationsTable] : []])]
}

function quoteSqliteIdentifier(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`
}

async function withSqliteClient<T>(target: Extract<MigrationTarget, { kind: "libsql" | "local" }>, run: (client: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const client = createClient(target.kind === "local" ? { url: `file:${target.path}` } : { authToken: target.authToken, url: target.url })
  try {
    return await run(client)
  }
  finally {
    client.close()
  }
}

async function readSqliteLedgers(client: ReturnType<typeof createClient>, recordedTables: readonly string[]): Promise<SqliteLedgers> {
  const candidates = [sqliteMigrationsTable, ...recordedTables]
  const existing = await client.execute({ args: candidates, sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${candidates.map(() => "?").join(", ")})` })
  const tables = new Set(existing.rows.map(row => String(row.name)))
  const ledgers: SqliteLedgers = { recorded: [] }
  if (tables.has(sqliteMigrationsTable)) {
    const result = await client.execute(`SELECT * FROM ${sqliteMigrationsTable}`)
    ledgers.drizzle = { named: result.columns.includes("name"), rows: result.rows.map(row => toLedgerRow({ ...row })) }
  }
  for (const table of recordedTables) {
    if (!tables.has(table)) continue
    const result = await client.execute(`SELECT name FROM ${quoteSqliteIdentifier(table)}`)
    ledgers.recorded.push({ names: result.rows.map(row => String(row.name)), table })
  }
  return ledgers
}

/** Reports a Drizzle ledger that Drizzle 1.0 cannot upgrade. */
function drizzleLedgerProblem(match: LedgerMatch, migrationsDir: string): string | undefined {
  const problem = ledgerUpgradeProblem(match)
  if (problem) return problem
  // Drizzle 1.0 adds `name` to a Drizzle Kit 0.x ledger first, and refuses rows that match no migration folder, for
  // example the rows of another Definition on the same database.
  if (match.unmatched.length) {
    return `Its Drizzle Kit 0.x migrations table has ${match.unmatched.length} row(s) (id ${match.unmatched.join(", ")}) that match no migration folder in ${migrationsDir}, so Drizzle 1.0 cannot upgrade it. Restore the missing folders, or give each Definition its own database.`
  }
  return undefined
}

/**
 * Matches the ledgers of a SQLite or libSQL database to the migration folders. Drizzle's ledger lists a migration by
 * folder name, or, for a renamed folder, by its SQL hash. Another tool's ledger lists it by one of the names that
 * `matchRecordedNames()` accepts. Returns the problem when Drizzle 1.0 or ViteHub would apply a migration again.
 */
interface SqliteLedgerMatch {
  /** The tag of each adopted migration, and the ledger that lists it. */
  adopted: Map<string, string>
  applied: Set<string>
  match: LedgerMatch
  /** The tag of each renamed folder, and the name that its row in Drizzle's ledger has. */
  renamed: Map<string, string>
}

function matchSqliteLedgers(ledgers: SqliteLedgers, entries: readonly MigrationEntry[], migrationsDir: string): SqliteLedgerMatch | { problem: string } {
  const rows = ledgers.drizzle?.rows ?? []
  const match = matchLedger(rows, entries)
  const problem = drizzleLedgerProblem(match, migrationsDir)
  if (problem) return { problem }
  const { applied } = match
  const renamed = matchRenamedRows(rows, entries, applied)
  const adopted = new Map([...renamed.keys()].map(tag => [tag, sqliteMigrationsTable]))
  if (!ledgers.recorded.some(ledger => ledger.names.length)) return { adopted, applied, match, renamed }
  const tags = new Set(entries.map(entry => entry.tag))
  const files = listD1Migrations(migrationsDir).filter(file => tags.has(file.tag))
  const unmatched = new Map<string, string>()
  for (const { names, table } of ledgers.recorded) {
    const recorded = matchRecordedNames(names, files)
    for (const tag of recorded.applied.keys()) {
      if (!applied.has(tag) && !adopted.has(tag)) adopted.set(tag, table)
    }
    for (const name of recorded.unmatched) unmatched.set(name, table)
  }
  const renumbered = findRenumbered([...unmatched.keys()], files, new Set([...applied, ...adopted.keys()]))
  if (renumbered) {
    const { moved, name } = renumbered
    return { problem: `The migrations table ${unmatched.get(name)} lists ${name}, but that migration is now ${moved.name} (${moved.tag}), so ViteHub would apply it again. Restore ${d1MigrationNamesFile} next to the migrations, or set "${moved.tag}": "${name.replace(/\.sql$/, "")}.sql" in it.` }
  }
  return { adopted, applied, match, renamed }
}

/** A Postgres client of the CLI: the part of postgres.js that migrations use, and `end()`. */
interface CliPostgresClient extends PostgresMigrationClient {
  end: () => Promise<unknown>
}

/** Loads a Postgres driver from the project. The app installs it, so load it from there, like Drizzle Kit does. */
function requireProjectDriver(name: "pg" | "postgres", projectRoot: string): unknown {
  try {
    return createRequire(join(projectRoot, "package.json"))(name)
  }
  catch (error) {
    throw databaseErrorDiagnostics.DATABASE_POSTGRES_DRIVER_MISSING({ cause: error, name })
  }
}

/** The server options of the PG* variables. A URL takes precedence over them. */
function readPostgresServerOptions(env: NodeJS.ProcessEnv) {
  return {
    database: env.PGDATABASE,
    host: env.PGHOST,
    password: env.PGPASSWORD,
    port: env.PGPORT ? Number(env.PGPORT) : undefined,
    user: env.PGUSERNAME ?? env.PGUSER,
  }
}

/** Opens a postgres.js client for the CLI with `connection.url` or the PG* variables, like the generated Kit config. */
export function connectPostgres(target: { url?: string }, projectRoot: string, env: NodeJS.ProcessEnv): postgres.Sql {
  const connect = requireProjectDriver("postgres", projectRoot) as typeof postgres
  const options = { ...readPostgresServerOptions(env), connect_timeout: 10, max: 1, onnotice: () => {} }
  return target.url ? connect(target.url, options) : connect(options)
}

/**
 * Opens a Postgres client for migrations with `connection.url` or the PG* variables, like the generated Kit config. It
 * uses node-postgres for `driver: "node-postgres"`, else postgres.js, and loads it from the project.
 */
function connectMigrationPostgres(target: { url?: string }, projectRoot: string, env: NodeJS.ProcessEnv, driver?: string): CliPostgresClient {
  if (driver === "node-postgres") {
    const { Pool } = requireProjectDriver("pg", projectRoot) as typeof import("pg")
    const pool = new Pool({ ...readPostgresServerOptions(env), ...target.url ? { connectionString: target.url } : {}, connectionTimeoutMillis: 10_000, max: 1 })
    return { ...toPostgresMigrationClient(pool), end: () => pool.end() }
  }
  const sql = connectPostgres(target, projectRoot, env)
  return { begin: run => sql.begin(run), end: () => sql.end({ timeout: 5 }), reserve: () => sql.reserve(), unsafe: (query, parameters) => sql.unsafe(query, parameters) }
}

async function readPostgresLedgerRows(sql: PostgresMigrationSql): Promise<LedgerRow[]> {
  const [table] = Array.from(await sql.unsafe("select to_regclass('drizzle.__drizzle_migrations')::text as name"))
  if (!table?.name) return []
  return Array.from(await sql.unsafe(`select * from ${postgresMigrationsTable}`)).map(row => toLedgerRow(row))
}

async function readPostgresLedger(target: Extract<MigrationTarget, { kind: "postgres" }>, options: MigrationPlanOptions, driver?: string): Promise<LedgerRow[]> {
  const sql = connectMigrationPostgres(target, options.projectRoot, options.env, driver)
  try {
    return await readPostgresLedgerRows(sql)
  }
  finally {
    await sql.end()
  }
}

function requireProjectPglite(projectRoot: string): typeof import("@electric-sql/pglite").PGlite {
  return (createRequire(join(projectRoot, "package.json"))("@electric-sql/pglite") as typeof import("@electric-sql/pglite")).PGlite
}

function connectMigrationPglite(path: string, projectRoot: string, database: ResolvedDrizzleDatabaseConfig): CliPostgresClient {
  let PGlite: typeof import("@electric-sql/pglite").PGlite
  try {
    PGlite = requireProjectPglite(projectRoot)
  }
  catch (error) {
    throw databaseErrorDiagnostics.DATABASE_PGLITE_NOT_INSTALLED({ cause: error, database: database.name, reason: database.driver === "pglite" ? "driver" : "no-connection" })
  }
  // PGlite creates the folder, but not its parent directories.
  mkdirSync(dirname(path), { recursive: true })
  const client = new PGlite(path)
  return { ...toPgliteMigrationClient(client), end: () => client.close() }
}

async function readPgliteLedger(path: string, projectRoot: string, fail: CheckFailure): Promise<LedgerRow[]> {
  let PGlite: typeof import("@electric-sql/pglite").PGlite
  try {
    PGlite = requireProjectPglite(projectRoot)
  }
  catch (error) {
    // Check it before the folder exists too: `vitehub database migrate` needs it to apply the first migration.
    throw fail("It runs on PGlite, because the Definition sets `driver: \"pglite\"` or has no `connection.url` and no PG* variables, but the project cannot load `@electric-sql/pglite`. Set `connection.url` to migrate a Postgres server, or install PGlite with `pnpm add -D @electric-sql/pglite`.", error)
  }
  // A missing folder has no applied migrations. Do not let PGlite create it.
  if (!existsSync(path)) return []
  const client = new PGlite(path)
  try {
    return await readPostgresLedgerRows(toPgliteMigrationClient(client))
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
  const fail: CheckFailure = (problem, cause) => databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ cause, database: database.name, problem })
  try {
    const entries = readMigrations(database.migrationsDir, database.name, { flat: target.kind === "d1-http" })
    if (target.kind === "d1-http") {
      const ledger = await readD1Ledger(createD1Query(target, fail, options.fetch), database, entries)
      const pending = listD1Migrations(database.migrationsDir)
        .filter(file => !ledger.applied.has(file.name))
        .map(file => readPendingMigration(database.migrationsDir, file.tag, entries, database.dialect))
      const adopted = ledger.adopted.map(migration => ({ from: migration.from, name: migration.tag }))
      return [undefined, { adopted, applied: ledger.applied.size, database: database.name, pending: withoutNewTableDataLoss(pending), target: describeTarget(target, options.projectRoot) }]
    }
    let applied: ReadonlySet<string>
    let adopted = new Map<string, string>()
    if (target.kind === "local" || target.kind === "libsql") {
      // A missing file has no applied migrations. Do not let libSQL create it.
      const ledgers = !entries.length || (target.kind === "local" && !existsSync(target.path))
        ? { recorded: [] }
        : await withSqliteClient(target, client => readSqliteLedgers(client, recordedLedgerTables(database)))
      const match = matchSqliteLedgers(ledgers, entries, database.migrationsDir)
      if ("problem" in match) return [databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ database: database.name, problem: match.problem }), undefined]
      applied = match.applied
      adopted = match.adopted
    }
    else {
      // Drizzle 1.0 applies each migration folder whose name the ledger does not list.
      const match = matchLedger(entries.length ? await readLedgerRows(target, options, fail, database.driver) : [], entries)
      const problem = drizzleLedgerProblem(match, database.migrationsDir)
      if (problem) return [databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ database: database.name, problem }), undefined]
      applied = match.applied
    }
    const pending = entries
      .filter(entry => !applied.has(entry.tag) && !adopted.has(entry.tag))
      .map(entry => readPendingMigration(database.migrationsDir, entry.tag, entries, database.dialect))
    return [undefined, {
      adopted: [...adopted].map(([name, from]) => ({ from, name })),
      applied: entries.length - pending.length,
      database: database.name,
      pending: withoutNewTableDataLoss(pending, database.dialect),
      target: describeTarget(target, options.projectRoot),
    }]
  }
  catch (error) {
    if (databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED.is(error)) return [error, undefined]
    const problem = error instanceof Error ? error.message : String(error)
    return [databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ cause: error, database: database.name, problem }), undefined]
  }
}

/**
 * Records the applied migrations that only another ledger lists in Drizzle's ledger of a SQLite or libSQL database,
 * so Drizzle Kit does not run them again. A Drizzle Kit 0.x ledger gets the upgrade of Drizzle 1.0 first, so the new
 * rows have names and cannot change how Drizzle matches the old ones. A renamed folder renames its row. Returns the
 * error when the check fails.
 */
export async function adoptSqliteMigrations(
  database: ResolvedDrizzleDatabaseConfig,
  options: MigrationPlanOptions,
  onAdopted: (migration: AdoptedMigration) => void,
): Promise<unknown> {
  const target = resolveTarget(database, options)
  if (target?.kind !== "local" && target?.kind !== "libsql") return
  if (target.kind === "local" && !existsSync(target.path)) return
  try {
    const entries = readMigrations(database.migrationsDir, database.name)
    if (!entries.length) return
    await withSqliteClient(target, async (client) => {
      const ledgers = await readSqliteLedgers(client, recordedLedgerTables(database))
      const match = matchSqliteLedgers(ledgers, entries, database.migrationsDir)
      if ("problem" in match) throw databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ database: database.name, problem: match.problem })
      if (!match.adopted.size) return
      const appliedAt = new Date().toISOString()
      await client.batch([
        ...!ledgers.drizzle
          ? [createSqliteMigrationsTable]
          : ledgers.drizzle.named ? [] : ledgerUpgradeStatements(sqliteMigrationsTable, match.match),
        ...entries.filter(entry => match.adopted.has(entry.tag)).map(entry => match.renamed.has(entry.tag)
          ? { args: [entry.tag, entry.when, match.renamed.get(entry.tag)!], sql: `UPDATE ${sqliteMigrationsTable} SET "name" = ?, "created_at" = ? WHERE "name" = ?` }
          : { args: [entry.hash, entry.when, entry.tag, appliedAt], sql: `INSERT INTO ${sqliteMigrationsTable} ("hash", "created_at", "name", "applied_at") VALUES (?, ?, ?, ?)` }),
      ], "write")
      for (const [name, from] of match.adopted) onAdopted({ from, name })
    })
  }
  catch (error) {
    return error
  }
}

/** Runs the SQLite migrations in process only when a pending migration needs statement splitting. */
export async function migrateSplitSqlite(
  database: ResolvedDrizzleDatabaseConfig,
  options: MigrationPlanOptions,
  check: () => Promise<boolean>,
  onApplied: (name: string) => void,
): Promise<number | undefined> {
  const target = resolveTarget(database, options)
  if (target?.kind !== "local" && target?.kind !== "libsql") return
  const scripts = readMigrations(database.migrationsDir, database.name).map(entry => {
    const sql = readFileSync(migrationSqlFile(database.migrationsDir, entry.tag), "utf8")
    return { ...entry, sql, needsSplit: addStatementBreakpoints(sql) !== sql }
  })
  if (!scripts.some(script => script.needsSplit)) return

  return await withSqliteClient(target, async (client) => {
    const ledgers = await readSqliteLedgers(client, recordedLedgerTables(database))
    const match = matchSqliteLedgers(ledgers, scripts, database.migrationsDir)
    if ("problem" in match) throw databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ database: database.name, problem: match.problem })
    const pending = scripts.filter(script => !match.applied.has(script.tag) && !match.adopted.has(script.tag))
    if (!pending.some(script => script.needsSplit)) return
    if (!await check()) return 1

    const appliedAt = new Date().toISOString()
    await client.migrate([
      ...!ledgers.drizzle ? [createSqliteMigrationsTable] : ledgers.drizzle.named ? [] : ledgerUpgradeStatements(sqliteMigrationsTable, match.match),
      ...pending.flatMap(script => [
        ...migrationParts(script.sql, "sqlite"),
        { args: [script.hash, script.when, script.tag, appliedAt], sql: `INSERT INTO ${sqliteMigrationsTable} ("hash", "created_at", "name", "applied_at") VALUES (?, ?, ?, ?)` },
      ]),
    ])
    for (const script of pending) onApplied(script.tag)
    return 0
  })
}

/**
 * Applies the pending migrations of a D1 HTTP database with Wrangler's ledger, so `wrangler d1 migrations apply` and
 * `vitehub database migrate` agree on what is applied. Returns the error, or a problem message, when a migration does not apply.
 */
export async function migrateD1Http(
  database: ResolvedDrizzleDatabaseConfig,
  options: MigrationPlanOptions,
  onApplied: (name: string) => void,
  onAdopted: (migration: AdoptedMigration) => void,
): Promise<unknown> {
  const target = resolveTarget(database, options)
  if (target?.kind !== "d1-http") return `The database "${database.name}" does not use D1 HTTP.`
  try {
    const query = createD1Query(target, problem => databaseErrorDiagnostics.DATABASE_D1_MIGRATION_FAILED({ database: database.name, problem }), options.fetch)
    const ledger = await readD1Ledger(query, database, readMigrations(database.migrationsDir, database.name, { flat: true }))
    await applyD1Migrations(query, ledger, database.migrationsDir, onApplied, migration => onAdopted({ from: migration.from, name: migration.tag }))
  }
  catch (error) {
    return error
  }
}

/**
 * Applies the pending migrations of the Postgres databases with the runtime's `migratePostgres()`, the one that a server
 * runs on start. It holds the same advisory lock, so `vitehub database migrate` and a starting server never migrate at the
 * same time, and Definitions on one Postgres database migrate together. A PGlite folder migrates the same way, and gets
 * the same ledger rows as `drizzle-kit migrate`. Returns the error when the migrations do not apply.
 */
export async function migratePostgresDatabases(
  databases: ResolvedDrizzleDatabaseConfig[],
  options: MigrationPlanOptions & { allowDataLoss: boolean },
  log: (message: string) => void,
): Promise<unknown> {
  const clients: CliPostgresClient[] = []
  try {
    const targets = databases.map((database): PostgresTarget => {
      const target = resolveTarget(database, options)
      if (target?.kind !== "postgres" && target?.kind !== "pglite") throw invariantError("`vitehub database migrate` passes only Postgres databases to migratePostgresDatabases()")
      const migrations = readStartMigrations(database.migrationsDir, database.dialect)
      const client = target.kind === "pglite"
        ? connectMigrationPglite(target.path, options.projectRoot, database)
        : connectMigrationPostgres(target, options.projectRoot, options.env, database.driver)
      clients.push(client)
      return { client, database: { migrations, name: database.name }, ...target.kind === "pglite" && { key: `pglite:${target.path}` } }
    })
    await migratePostgres(targets, { allowDataLoss: options.allowDataLoss, log })
  }
  catch (error) {
    return error
  }
  finally {
    await Promise.all(clients.map(client => client.end()))
  }
}
