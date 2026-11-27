import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"

import { createClient } from "@libsql/client"
import { dirname, join, resolve } from "pathe"

import { resolveConfigValue } from "../config-value.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { localPgliteDir, resolveLocalSqlitePath } from "../runtime/local-path.ts"
import { findMisplacedMigrations, findPostgresLedger, groupPostgresTargets, migratePostgres, misplacedLedgerError, reconcilePostgresHistory, toPgliteMigrationClient, toPostgresMigrationClient } from "../runtime/migrate-on-start.ts"
import { runsOnPglite } from "../runtime/postgres-env.ts"
import { invariantError } from "@vite-hub/internal/invariant"

import { applyD1Migrations, createD1Query, d1MigrationNamesFile, listD1Migrations, readD1Ledger } from "./d1-migrations.ts"
import { readStartMigrations } from "./migrate-on-start.ts"
import { migrationSqlFile, readMigrations, readPendingMigration } from "./migration-journal.ts"
import { findRenumbered, hubMigrationsTable, ledgerUpgradeProblem, ledgerUpgradeStatements, matchLedger, matchRecordedNames, matchRenamedRows, nameLedgerTables, toLedgerRow } from "./migration-ledger.ts"
import { addStatementBreakpoints, migrationParts, withoutNewTableDataLoss } from "./migration-sql.ts"
import { postgresLedgerTable } from "./postgres-ledger.ts"

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
  /** Names that another ledger lists and no migration folder matches. They do not block. Set for Postgres. */
  unmatched?: AdoptedMigration[]
}

/** An applied migration that `vitehub database migrate` takes from another ledger. */
export interface AdoptedMigration {
  /** The ledger table that lists it. */
  from: string
  /** The migration folder, or the flat file name without `.sql`. */
  name: string
}

export type MigrationPlanErrorCode = "DATABASE_MIGRATION_CHECK_FAILED" | "DATABASE_MIGRATION_LEDGER_MISPLACED" | "DATABASE_MIGRATION_SCHEMA_CONFLICT" | "DATABASE_MIGRATION_SCHEMA_DENIED" | "DATABASE_MIGRATION_SCHEMA_MISSING"

type CheckFailure = (problem: string, cause?: unknown) => Error

export interface MigrationPlanOptions {
  env: NodeJS.ProcessEnv
  fetch?: typeof fetch
  projectRoot: string
}

type MigrationTarget =
  | ({ kind: "d1-http" } & D1HttpTarget)
  | { kind: "libsql", authToken?: string, url: string }
  | { kind: "local", path: string }
  | { kind: "pglite", path: string }
  | { kind: "postgres", url?: string }

const sqliteMigrationsTable = "__drizzle_migrations"
const createSqliteMigrationsTable = `CREATE TABLE IF NOT EXISTS ${sqliteMigrationsTable} (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`

interface PostgresLedgerScope {
  createSchema?: boolean
  database: string
  schema?: string
}

function resolveTarget(database: ResolvedDrizzleDatabaseConfig, { env, projectRoot }: MigrationPlanOptions): MigrationTarget | undefined {
  if (database.dialect === "postgresql") return resolvePostgresTarget(database, { env, projectRoot })
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

function resolvePostgresTarget(database: ResolvedDrizzleDatabaseConfig, { env, projectRoot }: MigrationPlanOptions): Extract<MigrationTarget, { kind: "postgres" | "pglite" }> {
  if (database.dialect !== "postgresql") throw invariantError("Expected a Postgres database for migration.")
  const url = resolveConfigValue(database.connection?.url, env)?.trim() || undefined
  if (runsOnPglite(database.driver, url, env)) return { kind: "pglite", path: resolve(projectRoot, localPgliteDir(database.name)) }
  return { kind: "postgres", url }
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

interface SqliteLedgers {
  drizzle?: { named: boolean, rows: LedgerRow[] }
  recorded: Array<{ names: string[], table: string }>
}

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

function drizzleLedgerProblem(match: LedgerMatch, migrationsDir: string): string | undefined {
  const problem = ledgerUpgradeProblem(match)
  if (problem) return problem
  if (match.unmatched.length) {
    return `Its Drizzle Kit 0.x migrations table has ${match.unmatched.length} row(s) (id ${match.unmatched.join(", ")}) that match no migration folder in ${migrationsDir}, so Drizzle 1.0 cannot upgrade it. Restore the missing folders, or give each Definition its own database.`
  }
  return undefined
}

interface SqliteLedgerMatch {
  adopted: Map<string, string>
  applied: Set<string>
  match: LedgerMatch
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

interface CliPostgresClient extends PostgresMigrationClient {
  end: () => Promise<unknown>
}

function requireProjectDriver(name: "pg" | "postgres", projectRoot: string): unknown {
  try {
    return createRequire(join(projectRoot, "package.json"))(name)
  }
  catch (error) {
    throw databaseErrorDiagnostics.DATABASE_POSTGRES_DRIVER_MISSING({ cause: error, name })
  }
}

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

function connectMigrationPostgres(target: { url?: string }, projectRoot: string, env: NodeJS.ProcessEnv, driver?: string): CliPostgresClient {
  if (driver === "node-postgres") {
    const { Pool } = requireProjectDriver("pg", projectRoot) as typeof import("pg")
    const pool = new Pool({ ...readPostgresServerOptions(env), ...target.url ? { connectionString: target.url } : {}, connectionTimeoutMillis: 10_000, max: 1 })
    return { ...toPostgresMigrationClient(pool), end: () => pool.end() }
  }
  const sql = connectPostgres(target, projectRoot, env)
  return { begin: run => sql.begin(run), end: () => sql.end({ timeout: 5 }), unsafe: (query, parameters) => sql.unsafe(query, parameters) }
}

async function readPostgresLedger(sql: PostgresMigrationSql, scope: PostgresLedgerScope): Promise<LedgerRow[]> {
  if (await findPostgresLedger(sql, scope) !== "found") return []
  return Array.from(await sql.unsafe(`select * from ${postgresLedgerTable(scope.schema)}`)).map(row => toLedgerRow(row))
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
  mkdirSync(dirname(path), { recursive: true })
  const client = new PGlite(path)
  return { ...toPgliteMigrationClient(client), end: () => client.close() }
}

export type MigrationPlanResult = Result<MigrationPlan, MigrationPlanErrorCode>

function migrationCheckError(database: ResolvedDrizzleDatabaseConfig, error: unknown): MigrationPlanResult {
  if (databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED.is(error)
    || databaseErrorDiagnostics.DATABASE_MIGRATION_LEDGER_MISPLACED.is(error)
    || databaseErrorDiagnostics.DATABASE_MIGRATION_SCHEMA_CONFLICT.is(error)
    || databaseErrorDiagnostics.DATABASE_MIGRATION_SCHEMA_DENIED.is(error)
    || databaseErrorDiagnostics.DATABASE_MIGRATION_SCHEMA_MISSING.is(error)) return [error, undefined]
  const problem = error instanceof Error ? error.message : String(error)
  return [databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ cause: error, database: database.name, problem }), undefined]
}

function buildMigrationPlan(database: ResolvedDrizzleDatabaseConfig, target: MigrationTarget, options: MigrationPlanOptions, entries: MigrationEntry[], applied: ReadonlySet<string>, adopted: ReadonlyMap<string, string>): MigrationPlan {
  const pending = entries
    .filter(entry => !applied.has(entry.tag) && !adopted.has(entry.tag))
    .map(entry => readPendingMigration(database.migrationsDir, entry.tag, entries, database.dialect))
  return {
    adopted: [...adopted].map(([name, from]) => ({ from, name })),
    applied: entries.length - pending.length,
    database: database.name,
    pending: withoutNewTableDataLoss(pending, database.dialect),
    target: describeTarget(target, options.projectRoot),
  }
}

export async function readPostgresMigrationPlans(databases: ResolvedDrizzleDatabaseConfig[], options: MigrationPlanOptions): Promise<Map<string, MigrationPlanResult>> {
  const plans = new Map<string, MigrationPlanResult>()
  const targets: Array<{ client: CliPostgresClient, createSchema?: boolean, database: ResolvedDrizzleDatabaseConfig, entries: MigrationEntry[], key?: string, target: MigrationTarget }> = []
  try {
    for (const database of databases) {
      try {
        const target = resolvePostgresTarget(database, options)
        const entries = readMigrations(database.migrationsDir, database.name)
        const planEmpty = () => plans.set(database.name, [undefined, buildMigrationPlan(database, target, options, entries, new Set(), new Map())])
        if (!entries.length) {
          planEmpty()
          continue
        }
        if (target.kind === "postgres") {
          const client = connectMigrationPostgres(target, options.projectRoot, options.env, database.driver)
          targets.push({ client, database, entries, target })
          continue
        }
        let PGlite: typeof import("@electric-sql/pglite").PGlite
        try {
          PGlite = requireProjectPglite(options.projectRoot)
        }
        catch (error) {
          throw databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ cause: error, database: database.name, problem: "It runs on PGlite, because the Definition sets `driver: \"pglite\"` or has no `connection.url` and no PG* variables, but the project cannot load `@electric-sql/pglite`. Set `connection.url` to migrate a Postgres server, or install PGlite with `pnpm add -D @electric-sql/pglite`." })
        }
        if (!existsSync(target.path)) {
          planEmpty()
          continue
        }
        const db = new PGlite(target.path)
        const client = { ...toPgliteMigrationClient(db), end: () => db.close() }
        targets.push({ client, createSchema: true, database, entries, key: `pglite:${target.path}`, target })
      }
      catch (error) {
        plans.set(database.name, migrationCheckError(database, error))
      }
    }
    for (const group of await groupPostgresTargets(targets)) {
      const { client, createSchema, database } = group[0]!
      try {
        const migrations = group.flatMap(({ entries }) => entries)
        const schema = database.migrationsSchema
        const rows = await readPostgresLedger(client, { createSchema, database: database.name, schema })
        const match = matchLedger(rows, migrations)
        const problem = drizzleLedgerProblem(match, database.migrationsDir)
        if (problem) throw databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ database: database.name, problem })
        const history = await reconcilePostgresHistory(client, group.map(({ database, entries }) => ({ name: database.name, tags: entries.map(entry => entry.tag) })), match.applied, schema)
        const misplaced = await findMisplacedMigrations(client, { migrations, pending: migrations.filter(entry => !match.applied.has(entry.tag) && !history.adopted.includes(entry.tag)), schema })
        if (misplaced.exact.length || misplaced.unverified.length) throw misplacedLedgerError(database.name, schema!, migrations, misplaced, rows.length + history.adopted.length)
        for (const { database, target, entries } of group) {
          const adopted = new Map(entries.filter(entry => history.adopted.includes(entry.tag)).map(entry => [entry.tag, hubMigrationsTable]))
          const plan = buildMigrationPlan(database, target, options, entries, match.applied, adopted)
          if (database === group[0]!.database && history.unmatched.length) plan.unmatched = history.unmatched.map(name => ({ from: hubMigrationsTable, name }))
          plans.set(database.name, [undefined, plan])
        }
      }
      catch (error) {
        for (const { database } of group) plans.set(database.name, migrationCheckError(database, error))
      }
    }
  }
  catch (error) {
    for (const { database } of targets) plans.set(database.name, migrationCheckError(database, error))
  }
  finally {
    await Promise.all(targets.map(async ({ client, database }) => {
      try {
        await client.end()
      }
      catch (error) {
        if (!plans.get(database.name)?.[0]) plans.set(database.name, migrationCheckError(database, error))
      }
    }))
  }
  return plans
}

/**
 * Lists the migrations that `vitehub database migrate` would apply to one database, with their statements that lose data.
 * It reads the Drizzle migrations table, or Wrangler's `d1_migrations` table for D1 HTTP, and changes nothing.
 */
export async function readMigrationPlan(
  database: ResolvedDrizzleDatabaseConfig,
  options: MigrationPlanOptions,
): Promise<MigrationPlanResult> {
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
    if (target.kind === "postgres" || target.kind === "pglite") return (await readPostgresMigrationPlans([database], options)).get(database.name)!
    const entries = readMigrations(database.migrationsDir, database.name, { flat: target.kind === "d1-http" })
    if (target.kind === "d1-http") {
      const ledger = await readD1Ledger(createD1Query(target, fail, options.fetch), database, entries)
      const pending = listD1Migrations(database.migrationsDir)
        .filter(file => !ledger.applied.has(file.name))
        .map(file => readPendingMigration(database.migrationsDir, file.tag, entries, database.dialect))
      const adopted = ledger.adopted.map(migration => ({ from: migration.from, name: migration.tag }))
      return [undefined, { adopted, applied: ledger.applied.size, database: database.name, pending: withoutNewTableDataLoss(pending), target: describeTarget(target, options.projectRoot) }]
    }
    const ledgers = !entries.length || (target.kind === "local" && !existsSync(target.path))
      ? { recorded: [] }
      : await withSqliteClient(target, client => readSqliteLedgers(client, recordedLedgerTables(database)))
    const match = matchSqliteLedgers(ledgers, entries, database.migrationsDir)
    if ("problem" in match) return [databaseErrorDiagnostics.DATABASE_MIGRATION_CHECK_FAILED({ database: database.name, problem: match.problem }), undefined]
    return [undefined, buildMigrationPlan(database, target, options, entries, match.applied, match.adopted)]
  }
  catch (error) {
    return migrationCheckError(database, error)
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
      const target = resolvePostgresTarget(database, options)
      const migrations = readStartMigrations(database.migrationsDir, database.dialect)
      const client = target.kind === "pglite"
        ? connectMigrationPglite(target.path, options.projectRoot, database)
        : connectMigrationPostgres(target, options.projectRoot, options.env, database.driver)
      clients.push(client)
      return { client, database: { migrations, migrationsSchema: database.migrationsSchema, name: database.name }, ...target.kind === "pglite" && { createSchema: true, key: `pglite:${target.path}` } }
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
