import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { ledgerUpgradeProblem, matchLedger, toLedgerRow } from "../internal/migration-ledger.ts"
import { withoutNewTableDataLoss } from "../internal/migration-sql.ts"

import type { LedgerMatch, LedgerRow } from "../internal/migration-ledger.ts"
import type { DataLossStatement } from "../internal/migration-sql.ts"

/** A Drizzle Kit migration, read at build time so the server output does not need the migrations folder. */
export interface StartMigration {
  dataLoss: DataLossStatement[]
  /** SHA-256 of `migration.sql`, the hash that Drizzle's ledger stores. */
  hash: string
  /** The migration folder name, which Drizzle's ledger stores in `name`. */
  name: string
  statements: string[]
  /** The folder timestamp in milliseconds, which Drizzle's ledger stores as `created_at`. */
  when: number
}

export interface StartMigrationDatabase {
  /** The runtime Drizzle database of `useDatabase(name)`. */
  db: unknown
  dialect: "postgresql" | "sqlite"
  migrations: StartMigration[]
  name: string
}

/** `migrateOnStart.backup` as the build resolves it. */
export interface MigrationBackup {
  /** Relative to the working directory. Unset, the copies go to `backups` beside the database file. */
  dir?: string
  keep: number
}

export interface MigrateOnStartOptions {
  allowDataLoss?: boolean
  /** Copy each SQLite file before its pending migrations. */
  backup?: MigrationBackup
  log?: (message: string) => void
}

type LibsqlStatement = string | { args: unknown[], sql: string }

interface LibsqlMigrationClient {
  execute: (statement: LibsqlStatement) => Promise<{ rows: ArrayLike<ArrayLike<unknown> & Record<string, unknown>> }>
  migrate: (statements: LibsqlStatement[]) => Promise<unknown>
  protocol: string
}

interface StartMigrationPlan {
  client: LibsqlMigrationClient
  databases: StartMigrationDatabase[]
  /** The path of the main database file. Empty for an in-memory database. */
  file: string
  /** Statements that upgrade a ledger of Drizzle Kit 0.x before the migrations run. */
  upgrade: LibsqlStatement[]
  pending: Array<{ migration: StartMigration, name: string }>
}

// Drizzle's ledger, created and upgraded with the same statements as `drizzle-orm/libsql/migrator` 1.0, so
// `vitehub database migrate` and the server agree on what is applied.
const migrationsTable = "__drizzle_migrations"
const createMigrationsTable = `CREATE TABLE IF NOT EXISTS "${migrationsTable}" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`

function isLibsqlClient(value: unknown): value is LibsqlMigrationClient {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "execute") === "function"
    && typeof Reflect.get(value, "migrate") === "function"
    && typeof Reflect.get(value, "protocol") === "string"
}

/**
 * Reads the ledger and matches it to the migrations of every database on the file. A ledger of Drizzle Kit 0.x has no
 * `name` column; `upgrade` adds it and writes the name of each row, as Drizzle 1.0 does before it migrates.
 */
async function readLedger(client: LibsqlMigrationClient, databases: readonly StartMigrationDatabase[]): Promise<LedgerMatch & { hashes: Map<string, Set<string>>, upgrade: LibsqlStatement[] }> {
  const migrations = databases.flatMap(database => database.migrations.map(migration => ({ hash: migration.hash, tag: migration.name, when: migration.when })))
  const table = await client.execute({ args: [migrationsTable], sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?" })
  if (!table.rows.length) return { ...matchLedger([], migrations), hashes: new Map(), upgrade: [] }
  const columns = await client.execute(`PRAGMA table_info("${migrationsTable}")`)
  const named = Array.from(columns.rows).some(column => column.name === "name")
  const result = await client.execute(`SELECT * FROM "${migrationsTable}"`)
  const rows = Array.from(result.rows).map(row => toLedgerRow({ ...row }))
  const match = matchLedger(rows, migrations)
  const problem = ledgerUpgradeProblem(match)
  if (problem) throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({ database: databases[0]!.name, problem })
  const hashes = ledgerHashes(rows, match.backfill)
  if (named) return { ...match, hashes, upgrade: [] }
  return {
    ...match,
    hashes,
    upgrade: [
      `ALTER TABLE "${migrationsTable}" ADD COLUMN "name" text`,
      `ALTER TABLE "${migrationsTable}" ADD COLUMN "applied_at" TEXT`,
      ...match.backfill.map(({ column, name, value }) => ({ args: [name, value], sql: `UPDATE "${migrationsTable}" SET "name" = ?, "applied_at" = NULL WHERE "${column}" = ?` })),
    ],
  }
}

type PendingEntry = { migration: StartMigration, name: string }

/**
 * Lists the pending migrations of one database in the order they run, with the Definition of each. Drizzle 1.0 applies
 * each migration folder whose name the ledger does not list. Drizzle's ledger keys a migration by folder name only, so
 * Definitions on one database must not use one name for different SQL, or the ledger row of one would hide the other
 * forever. Unless `allowDataLoss` is set, it refuses migrations that lose data.
 */
function planByName(
  databases: ReadonlyArray<Pick<StartMigrationDatabase, "migrations" | "name">>,
  { applied, hashes }: { applied: Set<string>, hashes: Map<string, Set<string>> },
  { allowDataLoss, dialect, place }: { allowDataLoss?: boolean, dialect: "postgresql" | "sqlite", place: "Postgres database" | "SQLite file" },
): PendingEntry[] {
  const shared = databases.length > 1
  const separate = place === "SQLite file" ? "separate SQLite files" : "a separate Postgres database for each"
  const seen = new Map<string, { hash: string, name: string }>()
  const pending = new Map<string, PendingEntry>()
  for (const database of databases) {
    for (const migration of database.migrations) {
      const other = seen.get(migration.name)
      if (other && other.hash !== migration.hash) {
        throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({
          database: database.name,
          problem: `It and the Database "${other.name}" share one ${place}, and both have the migration "${migration.name}" with different SQL. Drizzle's migrations table keys migrations by folder name, so one of them would never run. Regenerate one of them with another name, or use ${separate}.`,
        })
      }
      seen.set(migration.name, { hash: migration.hash, name: database.name })
      const recorded = hashes.get(migration.name)
      if (shared && recorded && !recorded.has(migration.hash)) {
        throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({
          database: database.name,
          problem: `Its shared ${place} has already applied a migration "${migration.name}" with other SQL, so this one would never run. Regenerate it with another name, or use ${separate}.`,
        })
      }
      if (!applied.has(migration.name) && !pending.has(migration.name)) pending.set(migration.name, { migration, name: database.name })
    }
  }
  const ordered = [...pending.values()].sort((a, b) => a.migration.when - b.migration.when || a.migration.name.localeCompare(b.migration.name))
  if (allowDataLoss) return ordered
  // Check the migrations in the order they run, so a table that this run creates can lose its rows.
  const checked = withoutNewTableDataLoss(ordered.map(({ migration }) => migration), dialect)
  for (const database of databases) {
    const losses = checked.flatMap((migration, index) => ordered[index]!.name === database.name
      ? migration.dataLoss.map(loss => `${migration.name}: ${loss.reason}: ${loss.statement}`)
      : [])
    if (losses.length) throw databaseErrorDiagnostics.DATABASE_MIGRATION_DATA_LOSS({ database: database.name, statements: losses })
  }
  return ordered
}

/** The hashes that the ledger stores for each applied folder name, including the names that an upgrade writes. */
function ledgerHashes(rows: readonly LedgerRow[], backfill: LedgerMatch["backfill"]): Map<string, Set<string>> {
  const hashes = new Map<string, Set<string>>()
  const backfilled = new Map(backfill.map(({ row, name }) => [row, name]))
  for (const row of rows) {
    const name = row.name ?? backfilled.get(row)
    if (name) hashes.set(name, (hashes.get(name) ?? new Set()).add(row.hash))
  }
  return hashes
}

/**
 * Applies the pending migrations of each database before the server handles requests. It uses Drizzle Kit's ledger and
 * refuses migrations that lose data, like `vitehub database migrate`. It checks every database before the first one changes,
 * so a refusal leaves all of them as they were.
 *
 * A local SQLite file runs all its pending migrations in one transaction. A Postgres database runs them in one
 * transaction that holds the migration lock, so of several servers that start together, one migrates and the others
 * wait and then find nothing pending. A failure keeps none of the pending migrations of that database.
 */
export async function migrateOnStart(databases: StartMigrationDatabase[], options: MigrateOnStartOptions = {}): Promise<void> {
  const log = options.log ?? (message => console.info(message))
  const postgresDatabase = databases.find(database => database.dialect === "postgresql")
  if (options.backup && postgresDatabase) {
    throw databaseErrorDiagnostics.DATABASE_MIGRATION_BACKUP_UNSUPPORTED({ database: postgresDatabase.name, problem: "It is a Postgres database." })
  }
  const sqlitePlans = await planSqlite(databases.filter(database => database.dialect === "sqlite"), options)
  const postgres = databases.filter(database => database.dialect === "postgresql").map((database) => {
    const value: unknown = Reflect.get(Object(database.db), "$client")
    const client = isPostgresClient(value) ? value : isNodePostgresPool(value) ? toPostgresMigrationClient(value) : undefined
    if (!client) {
      throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({ database: database.name, problem: "Its client is not postgres.js or a node-postgres Pool." })
    }
    return { client, database }
  })
  // The SQLite files change only after every Postgres database passed its check under the lock.
  await migratePostgres(postgres, { ...options, beforeApply: () => applySqlite(sqlitePlans, options.backup, log), log })
}

/** The migrations that a server build ships, by Database name. The build writes them, so the server needs no migrations folder. */
export interface ShippedMigrations {
  allowDataLoss: boolean
  backup?: MigrationBackup
  /** A Database without migrations is not listed. `problem` says why the build could not read its migrations. */
  databases: Record<string, Pick<StartMigrationDatabase, "dialect" | "migrations"> | { problem: string }>
  /** Why this build cannot apply migrations in the server process. */
  unsupported?: string
}

export interface EnsureMigrationsContext {
  /** The internal Database registry of the app. */
  databases: Record<string, { db: unknown }>
  load: () => Promise<ShippedMigrations>
}

// One run for each Database in this process. The server start and `ensureMigrations()` share it.
const runs = new Map<string, Promise<void>>()
// Runs start one after the other. Definitions on one SQLite file share its ledger, so a run must read it after the
// previous run committed, or both apply the same migration.
let lastRun: Promise<unknown> = Promise.resolve()

/**
 * Applies the pending migrations of `names`, or of every Database, once in this process. It runs `migrateOnStart()`,
 * so a Postgres database migrates under the advisory lock. Calls during a run and after a successful run share that
 * run. A run that fails is forgotten, so the next call starts a new one. A new run waits for the previous run, so
 * Definitions that share a SQLite file apply each migration once.
 *
 * In app tests, a SQLite Database is an in-memory copy that already has its migrations, so it is skipped.
 */
export function ensureDatabaseMigrations(context: EnsureMigrationsContext, names?: readonly string[]): Promise<void> {
  const selected = names ?? Object.keys(context.databases)
  const unknown = selected.find(name => !Object.hasOwn(context.databases, name))
  if (unknown !== undefined) return Promise.reject(databaseErrorDiagnostics.DATABASE_NOT_FOUND({ database: unknown }))
  const missing = [...new Set(selected.filter(name => !runs.has(name)))]
  if (missing.length) {
    const run = lastRun.then(() => context.load()).then(async (shipped) => {
      if (shipped.unsupported) throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({ problem: shipped.unsupported })
      const test = getViteHubTestMode()
      await migrateOnStart(missing.flatMap((name) => {
        const database = Object.hasOwn(shipped.databases, name) ? shipped.databases[name] : undefined
        if (database && "problem" in database) throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({ database: name, problem: database.problem })
        if (!database?.migrations.length || (test && database.dialect === "sqlite")) return []
        return [{ db: context.databases[name]!.db, dialect: database.dialect, migrations: database.migrations, name }]
      }), { allowDataLoss: shipped.allowDataLoss, backup: shipped.backup })
    })
    for (const name of missing) runs.set(name, run)
    lastRun = run.catch(() => {
      for (const name of missing) if (runs.get(name) === run) runs.delete(name)
    })
  }
  return Promise.all(selected.map(name => runs.get(name))).then(() => undefined)
}

async function planSqlite(databases: StartMigrationDatabase[], options: MigrateOnStartOptions): Promise<StartMigrationPlan[]> {
  const plans = new Map<string | LibsqlMigrationClient, StartMigrationPlan>()
  for (const database of databases) {
    const client: unknown = Reflect.get(Object(database.db), "$client")
    if (!isLibsqlClient(client) || client.protocol !== "file") {
      const target = isLibsqlClient(client) ? `libSQL over ${client.protocol}` : "a connection that is not libSQL"
      throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({ database: database.name, problem: `It uses ${target}.` })
    }
    // Separate clients and URL spellings can open the same file. SQLite reports the actual main database path.
    const files = await client.execute("PRAGMA database_list")
    const file = Array.from(files.rows).find(row => row[1] === "main")?.[2]
    if (options.backup && (typeof file !== "string" || !file)) {
      throw databaseErrorDiagnostics.DATABASE_MIGRATION_BACKUP_UNSUPPORTED({ database: database.name, problem: "It is in memory." })
    }
    // In-memory databases have no file path and belong only to their client.
    const target = typeof file === "string" && file ? file : client
    const plan = plans.get(target) ?? { client, databases: [], file: typeof file === "string" ? file : "", pending: [], upgrade: [] }
    plan.databases.push(database)
    plans.set(target, plan)
  }
  for (const plan of plans.values()) {
    const { applied, hashes, unmatched, upgrade } = await readLedger(plan.client, plan.databases)
    if (upgrade.length && unmatched.length) {
      throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({
        database: plan.databases[0]!.name,
        problem: `Its Drizzle Kit 0.x ledger has ${unmatched.length} applied migration(s) that match no migration folder, so Drizzle 1.0 cannot upgrade it. Restore the missing migration folders.`,
      })
    }
    plan.upgrade = upgrade
    plan.pending = planByName(plan.databases, { applied, hashes }, { allowDataLoss: options.allowDataLoss, dialect: "sqlite", place: "SQLite file" })
  }
  return [...plans.values()]
}

async function applySqlite(plans: StartMigrationPlan[], backup: MigrationBackup | undefined, log: (message: string) => void) {
  // Copy every file before the first one changes, so a failed copy leaves all of them as they were.
  if (backup) for (const plan of plans) if (plan.pending.length) await backupSqlite(plan, backup, log)
  for (const { client, pending, upgrade } of plans) {
    if (!pending.length && !upgrade.length) continue
    await client.migrate([
      createMigrationsTable,
      ...upgrade,
      ...pending.flatMap(({ migration }) => [
        ...migration.statements,
        { args: [migration.hash, migration.when, migration.name, new Date().toISOString()], sql: `INSERT INTO "${migrationsTable}" ("hash", "created_at", "name", "applied_at") VALUES (?, ?, ?, ?)` },
      ]),
    ])
    for (const { migration, name } of pending) log(`[vitehub] Database "${name}": applied ${migration.name}.`)
  }
}

/**
 * Copies a SQLite file with `VACUUM INTO`, which writes a consistent copy while other connections can read, then
 * deletes the oldest copies of that file beyond `keep`. An empty database has nothing to keep, so it gets no copy.
 * Copies are `<file name>-<UTC time>-before-<last pending migration><extension>`, so they sort by time.
 */
async function backupSqlite({ client, databases, file, pending }: StartMigrationPlan, backup: MigrationBackup, log: (message: string) => void) {
  const objects = await client.execute("SELECT count(*) AS count FROM sqlite_master")
  if (!Number(objects.rows[0]?.[0])) return
  // Hosted builds bundle this module without Node's file system, so it reads the built-ins only when a copy is due.
  const { mkdir, readdir, rm } = process.getBuiltinModule("fs/promises")
  const { basename, dirname, extname, join, resolve } = process.getBuiltinModule("path")
  const dir = backup.dir ? resolve(backup.dir) : join(dirname(file), "backups")
  const extension = extname(file) || ".db"
  // A shared directory must keep retention independent for files with the same basename.
  const identity = backup.dir ? `-${process.getBuiltinModule("crypto").createHash("sha256").update(file).digest("hex")}` : ""
  const stem = `${basename(file, extname(file))}${identity}`
  const time = new Date().toISOString().replaceAll(":", "-").replace(".", "-")
  const target = join(dir, `${stem}-${time}-before-${pending.at(-1)!.migration.name}${extension}`)
  const copy = new RegExp(`^${escapeRegExp(stem)}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-before-.+${escapeRegExp(extension)}$`)
  try {
    await mkdir(dir, { recursive: true })
    await client.execute({ args: [target], sql: "VACUUM INTO ?" })
    const copies = (await readdir(dir)).filter(name => copy.test(name)).sort()
    for (const name of copies.slice(0, -backup.keep)) await rm(join(dir, name))
  }
  catch (error) {
    throw databaseErrorDiagnostics.DATABASE_MIGRATION_BACKUP_FAILED({
      cause: error,
      database: databases[0]!.name,
      problem: error instanceof Error ? error.message : String(error),
      target,
    })
  }
  log(`[vitehub] Database "${databases[0]!.name}": copied ${file} to ${target} before ${pending.length} migration(s).`)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** The part of a postgres.js client, or of one of its transactions, that migrations use. */
export interface PostgresMigrationSql {
  unsafe: (query: string, parameters?: Array<number | string>) => PromiseLike<ArrayLike<Record<string, unknown>>>
}

/** The part of a postgres.js client that migrations use. */
export interface PostgresMigrationClient extends PostgresMigrationSql {
  begin: <T>(run: (sql: PostgresMigrationSql) => Promise<T>) => PromiseLike<unknown>
}

function isPostgresClient(value: unknown): value is PostgresMigrationClient {
  return typeof value === "function"
    && typeof Reflect.get(value, "begin") === "function"
    && typeof Reflect.get(value, "unsafe") === "function"
}

/** The part of a node-postgres Pool, or of one of its clients, that migrations use. */
interface NodePostgresQueryable {
  query: (query: string, parameters?: Array<number | string>) => Promise<{ rows: Array<Record<string, unknown>> }>
}

interface NodePostgresPool extends NodePostgresQueryable {
  connect: () => Promise<NodePostgresQueryable & { release: (error?: Error) => void }>
}

function isNodePostgresPool(value: unknown): value is NodePostgresPool {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "connect") === "function"
    && typeof Reflect.get(value, "query") === "function"
}

function nodePostgresSql(queryable: NodePostgresQueryable): PostgresMigrationSql {
  return { unsafe: async (query, parameters) => (await queryable.query(query, parameters)).rows }
}

/** Runs migrations on a node-postgres Pool: `begin()` takes one client of the pool and wraps the run in a transaction. */
export function toPostgresMigrationClient(pool: NodePostgresPool): PostgresMigrationClient {
  return {
    ...nodePostgresSql(pool),
    begin: async (run) => {
      const client = await pool.connect()
      let failure: Error | undefined
      try {
        await client.query("begin")
        const result = await run(nodePostgresSql(client))
        await client.query("commit")
        return result
      }
      catch (error) {
        await client.query("rollback").catch((rollbackError: unknown) => {
          // A client that cannot roll back must not go back to the pool.
          failure = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
        })
        throw error
      }
      finally {
        client.release(failure)
      }
    },
  }
}

/**
 * The key of the Postgres advisory lock that every ViteHub migration of a Postgres database holds: migrate on start
 * and `vitehub database migrate`. Advisory locks belong to one database, and so does Drizzle Kit's ledger. Read it with
 * `select * from pg_locks where locktype = 'advisory'` while a migration waits.
 */
export const postgresMigrationLock = "vitehub:migrations"

// Drizzle's Postgres ledger, created and upgraded with the statements of `migrate` in `drizzle-orm/pg-core/async/session`
// 1.0, so `drizzle-kit migrate`, `vitehub database migrate` and a starting server agree on what is applied.
const postgresLedger = "\"drizzle\".\"__drizzle_migrations\""
const createPostgresLedger = `CREATE TABLE IF NOT EXISTS ${postgresLedger} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint, name text, applied_at timestamp with time zone DEFAULT now())`

/** One Postgres database, and the Definitions that migrate it. They share Drizzle's ledger in that database. */
export interface PostgresTarget {
  client: PostgresMigrationClient
  database: Pick<StartMigrationDatabase, "migrations" | "name">
}

/**
 * Names the Postgres database that a client reaches, as the server reports it: the database name and the server start
 * time as Unix seconds. Every session gets the same key, whatever its address (a Unix socket, a TCP address, two URL
 * spellings), its `TimeZone`, or its role.
 */
export async function readPostgresDatabaseKey(client: PostgresMigrationSql): Promise<string> {
  return (await readPostgresIdentity(client)).key
}

async function readPostgresIdentity(client: PostgresMigrationSql) {
  const [row] = Array.from(await client.unsafe("select current_database() as database, extract(epoch from pg_postmaster_start_time())::text as started, current_user as role, current_schemas(false) as schemas"))
  return { key: JSON.stringify([row?.database, row?.started]), session: JSON.stringify([row?.role, row?.schemas]) }
}

/**
 * Groups the Definitions by the Postgres database that their clients reach, and sorts the groups by that key. Every
 * process then takes the locks of several databases in the same order, so two of them never wait for each other.
 */
async function groupPostgresTargets(targets: PostgresTarget[]): Promise<PostgresTarget[][]> {
  if (targets.length < 2) return targets.length ? [targets] : []
  const groups = new Map<string, { session: string, targets: PostgresTarget[] }>()
  for (const target of targets) {
    const { key, session } = await readPostgresIdentity(target.client)
    const group = groups.get(key)
    if (group && group.session !== session) {
      throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({
        database: target.database.name,
        problem: `It and the Database "${group.targets[0]!.database.name}" share one Postgres database but use different roles or schema search paths. Configure them with the same role and search_path so their migrations can run in one transaction.`,
      })
    }
    if (group) group.targets.push(target)
    else groups.set(key, { session, targets: [target] })
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group.targets)
}

/**
 * Creates or upgrades Drizzle's ledger and lists the pending migrations of a group. Call it in the transaction that
 * holds the lock. A ledger of Drizzle Kit 0.x has no `name` column: like Drizzle 1.0, it adds `name` and `applied_at`
 * and writes the name of each row, and it refuses a row that matches no migration folder.
 */
async function planPostgres(sql: PostgresMigrationSql, group: PostgresTarget[], options: MigrateOnStartOptions): Promise<PendingEntry[]> {
  const databases = group.map(target => target.database)
  const migrations = databases.flatMap(database => database.migrations.map(migration => ({ hash: migration.hash, tag: migration.name, when: migration.when })))
  const [existing] = Array.from(await sql.unsafe("select to_regclass('drizzle.__drizzle_migrations') as ledger"))
  if (!existing?.ledger) {
    await sql.unsafe("CREATE SCHEMA IF NOT EXISTS \"drizzle\"")
    await sql.unsafe(createPostgresLedger)
  }
  else {
    const columns = Array.from(await sql.unsafe("select column_name from information_schema.columns where table_schema = 'drizzle' and table_name = '__drizzle_migrations'")).map(row => row.column_name)
    if (!columns.includes("name")) {
      const rows = Array.from(await sql.unsafe(`SELECT id, hash, created_at FROM ${postgresLedger} ORDER BY id ASC`)).map(row => toLedgerRow(row))
      const match = matchLedger(rows, migrations)
      const { backfill, unmatched } = match
      const problem = ledgerUpgradeProblem(match)
      if (problem) throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({ database: databases[0]!.name, problem })
      if (unmatched.length) {
        throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({
          database: databases[0]!.name,
          problem: `Its Drizzle Kit 0.x ledger has ${unmatched.length} applied migration(s) (id ${unmatched.join(", ")}) that match no migration folder, so Drizzle 1.0 cannot upgrade it. Restore the missing migration folders.`,
        })
      }
      await sql.unsafe(`ALTER TABLE ${postgresLedger} ADD COLUMN IF NOT EXISTS "name" text`)
      await sql.unsafe(`ALTER TABLE ${postgresLedger} ADD COLUMN IF NOT EXISTS "applied_at" timestamp with time zone DEFAULT now()`)
      for (const { column, name, value } of backfill) await sql.unsafe(`UPDATE ${postgresLedger} SET "name" = $1, "applied_at" = NULL WHERE "${column}" = $2`, [name, value])
    }
  }
  const rows = Array.from(await sql.unsafe(`select id, hash, created_at, name from ${postgresLedger}`)).map(row => toLedgerRow(row))
  const match = matchLedger(rows, migrations)
  return planByName(databases, { applied: match.applied, hashes: ledgerHashes(rows, match.backfill) }, { allowDataLoss: options.allowDataLoss, dialect: "postgresql", place: "Postgres database" })
}

/** Runs `run` in a transaction that holds the migration lock of the group's database. */
async function withPostgresLock(group: PostgresTarget[], log: (message: string) => void, run: (sql: PostgresMigrationSql) => Promise<void>) {
  await group[0]!.client.begin(async (sql) => {
    const [lock] = Array.from(await sql.unsafe("select pg_try_advisory_xact_lock(hashtext($1)) as locked", [postgresMigrationLock]))
    if (lock?.locked !== true) {
      log(`[vitehub] Database "${group[0]!.database.name}": another process is applying migrations. Waiting for it to finish.`)
      await sql.unsafe("select pg_advisory_xact_lock(hashtext($1))", [postgresMigrationLock])
    }
    // Bound DDL lock waits so a queued ALTER cannot stall old instances' reads indefinitely. Advisory waits stay unbounded.
    await sql.unsafe("set local lock_timeout = '5s'")
    // postgres.js prints notices, such as "schema already exists, skipping", on stdout by default.
    await sql.unsafe("set local client_min_messages = warning")
    await run(sql)
  })
}

/**
 * Holds the lock of every group, in key order, for all of `run`. Each group is a separate database, because the key is
 * the same for every session of one database, so this process never waits for a lock that it holds itself.
 */
async function withPostgresLocks(groups: PostgresTarget[][], log: (message: string) => void, run: (sqls: PostgresMigrationSql[]) => Promise<void>, held: PostgresMigrationSql[] = []): Promise<void> {
  if (held.length === groups.length) return await run(held)
  await withPostgresLock(groups[held.length]!, log, sql => withPostgresLocks(groups, log, run, [...held, sql]))
}

export interface MigratePostgresOptions extends MigrateOnStartOptions {
  /** Runs after every database passed its check, before the first one changes. */
  beforeApply?: () => Promise<void>
}

/**
 * Applies the pending migrations of Postgres Definitions. Definitions on one Postgres database migrate together, in
 * one transaction that first takes the advisory lock `postgresMigrationLock` and only then reads Drizzle Kit's ledger.
 * It keeps the lock until the transaction commits, so a second process waits and then reads the committed ledger, and
 * each migration runs once. It checks every database before the first one changes. The ledger rows are the ones that
 * drizzle-orm writes, so `drizzle-kit migrate` and ViteHub agree on what is applied.
 *
 * Returns the names of the applied migrations. A failed statement rolls back the transaction, so the database keeps
 * none of the pending migrations, and it throws `DATABASE_MIGRATION_FAILED`.
 */
export async function migratePostgres(targets: PostgresTarget[], options: MigratePostgresOptions = {}): Promise<string[]> {
  const log = options.log ?? (message => console.info(message))
  const groups = await groupPostgresTargets(targets)
  // The transaction callback sets these, so the catch can name the migration that failed.
  const progress: { applied: PendingEntry[], running?: PendingEntry } = { applied: [] }
  try {
    await withPostgresLocks(groups, log, async (sqls) => {
      const plans: PendingEntry[][] = []
      for (const [index, group] of groups.entries()) plans.push(await planPostgres(sqls[index]!, group, options))
      await options.beforeApply?.()
      for (const [index, pending] of plans.entries()) {
        const sql = sqls[index]!
        for (const entry of pending) {
          progress.running = entry
          for (const statement of entry.migration.statements) await sql.unsafe(statement)
          await sql.unsafe(`insert into ${postgresLedger} ("hash", "created_at", "name") values ($1, $2, $3)`, [entry.migration.hash, entry.migration.when, entry.migration.name])
          progress.applied.push(entry)
        }
      }
      progress.running = undefined
    })
  }
  catch (error) {
    if (!progress.running) throw error
    throw databaseErrorDiagnostics.DATABASE_MIGRATION_FAILED({
      cause: error,
      database: progress.running.name,
      migration: progress.running.migration.name,
      problem: error instanceof Error ? error.message : String(error),
    })
  }
  for (const { migration, name } of progress.applied) log(`[vitehub] Database "${name}": applied ${migration.name}.`)
  return progress.applied.map(({ migration }) => migration.name)
}
