import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { matchLedger, toLedgerRow } from "../internal/migration-ledger.ts"
import { withoutNewTableDataLoss } from "../internal/migration-sql.ts"

import type { LedgerMatch } from "../internal/migration-ledger.ts"
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

export interface MigrateOnStartOptions {
  allowDataLoss?: boolean
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
  /** Statements that upgrade a ledger of Drizzle Kit 0.x before the migrations run. */
  upgrade: LibsqlStatement[]
  pending: Map<string, { migration: StartMigration, name: string }>
}

// Drizzle's ledger, created and upgraded with the same statements as `drizzle-orm/libsql/migrator` 1.0, so
// `vitehub db migrate` and the server agree on what is applied.
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
  // The hashes that the ledger stores for each applied folder name, including the names that the upgrade writes.
  const hashes = new Map<string, Set<string>>()
  const backfilled = new Map(match.backfill.map(({ id, name }) => [id, name]))
  for (const row of rows) {
    const name = row.name ?? backfilled.get(row.id)
    if (name) hashes.set(name, (hashes.get(name) ?? new Set()).add(row.hash))
  }
  if (named) return { ...match, hashes, upgrade: [] }
  return {
    ...match,
    hashes,
    upgrade: [
      `ALTER TABLE "${migrationsTable}" ADD COLUMN "name" text`,
      `ALTER TABLE "${migrationsTable}" ADD COLUMN "applied_at" TEXT`,
      ...match.backfill.map(({ id, name }) => ({ args: [name, id], sql: `UPDATE "${migrationsTable}" SET "name" = ?, "applied_at" = NULL WHERE "id" = ?` })),
    ],
  }
}

/**
 * Applies the pending migrations of each database before the server handles requests. It uses Drizzle Kit's ledger and
 * refuses migrations that lose data, like `vitehub db migrate`. It checks every database before the first one changes,
 * so a refusal leaves all of them as they were.
 *
 * A local SQLite file runs all its pending migrations in one transaction. A Postgres database runs them in one
 * transaction that holds the migration lock, so of several servers that start together, one migrates and the others
 * wait and then find nothing pending. A failure keeps none of the pending migrations of that database.
 */
export async function migrateOnStart(databases: StartMigrationDatabase[], options: MigrateOnStartOptions = {}): Promise<void> {
  const log = options.log ?? (message => console.info(message))
  const sqlitePlans = await planSqlite(databases.filter(database => database.dialect === "sqlite"), options)
  const postgres = databases.filter(database => database.dialect === "postgresql").map((database) => {
    const client: unknown = Reflect.get(Object(database.db), "$client")
    if (!isPostgresClient(client)) {
      throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({ database: database.name, problem: "Its client is not postgres.js." })
    }
    return { client, database }
  })
  // The SQLite files change only after every Postgres database passed its check under the lock.
  await migratePostgres(postgres, { ...options, beforeApply: () => applySqlite(sqlitePlans, log), log })
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
    // In-memory databases have no file path and belong only to their client.
    const target = typeof file === "string" && file ? file : client
    const plan = plans.get(target) ?? { client, databases: [], pending: new Map<string, { migration: StartMigration, name: string }>(), upgrade: [] }
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
    // Drizzle's ledger keys a migration by folder name only. Definitions on one file must not use one name for
    // different SQL, or the ledger row of one would hide the other forever.
    const shared = plan.databases.length > 1
    const seen = new Map<string, { hash: string, name: string }>()
    for (const database of plan.databases) {
      for (const migration of database.migrations) {
        const other = seen.get(migration.name)
        if (other && other.hash !== migration.hash) {
          throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({
            database: database.name,
            problem: `It and the Database "${other.name}" share one SQLite file, and both have the migration "${migration.name}" with different SQL. Drizzle's migrations table keys migrations by folder name, so one of them would never run. Regenerate one of them with another name, or use separate SQLite files.`,
          })
        }
        seen.set(migration.name, { hash: migration.hash, name: database.name })
        const recorded = hashes.get(migration.name)
        if (shared && recorded && !recorded.has(migration.hash)) {
          throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({
            database: database.name,
            problem: `Its shared SQLite file has already applied a migration "${migration.name}" with other SQL, so this one would never run. Regenerate it with another name, or use separate SQLite files.`,
          })
        }
        // Drizzle 1.0 applies each migration folder whose name the ledger does not list.
        if (!applied.has(migration.name) && !plan.pending.has(migration.name)) plan.pending.set(migration.name, { migration, name: database.name })
      }
    }
    if (options.allowDataLoss) continue
    // Check the migrations in the order they run on the file, so a table that this run creates can lose its rows.
    const pending = [...plan.pending.values()].sort((a, b) => a.migration.when - b.migration.when)
    const checked = withoutNewTableDataLoss(pending.map(({ migration }) => migration))
    for (const database of plan.databases) {
      const losses = checked.flatMap((migration, index) => pending[index]!.name === database.name
        ? migration.dataLoss.map(loss => `${migration.name}: ${loss.reason}: ${loss.statement}`)
        : [])
      if (losses.length) throw databaseErrorDiagnostics.DATABASE_MIGRATION_DATA_LOSS({ database: database.name, statements: losses })
    }
  }
  return [...plans.values()]
}

async function applySqlite(plans: StartMigrationPlan[], log: (message: string) => void) {
  for (const { client, pending: migrations, upgrade } of plans) {
    if (!migrations.size) continue
    const pending = [...migrations.values()].sort((a, b) => a.migration.when - b.migration.when || a.migration.name.localeCompare(b.migration.name))
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

/**
 * The key of the Postgres advisory lock that every ViteHub migration of a Postgres database holds: migrate on start
 * and `vitehub db migrate`. Advisory locks belong to one database, and so does Drizzle Kit's ledger. Read it with
 * `select * from pg_locks where locktype = 'advisory'` while a migration waits.
 */
export const postgresMigrationLock = "vitehub:migrations"

// Drizzle Kit's Postgres ledger, created with the statements of `PgDialect.migrate` in drizzle-orm.
const postgresLedger = "\"drizzle\".\"__drizzle_migrations\""
const createPostgresLedger = [
  "CREATE SCHEMA IF NOT EXISTS \"drizzle\"",
  `CREATE TABLE IF NOT EXISTS ${postgresLedger} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
]

/** One Postgres database, and the Definitions that migrate it. They share Drizzle Kit's ledger in that database. */
export interface PostgresTarget {
  client: PostgresMigrationClient
  database: Pick<StartMigrationDatabase, "migrations" | "name">
}

/**
 * Groups the Definitions by the Postgres database that their clients reach. The server reports the database, so two URL
 * spellings of one database go in one group.
 */
async function groupPostgresTargets(targets: PostgresTarget[]): Promise<PostgresTarget[][]> {
  if (targets.length < 2) return targets.length ? [targets] : []
  const groups = new Map<string, PostgresTarget[]>()
  for (const target of targets) {
    const [row] = Array.from(await target.client.unsafe("select current_database() as database, inet_server_addr()::text as address, inet_server_port() as port, pg_postmaster_start_time()::text as started"))
    const key = JSON.stringify([row?.database, row?.address, row?.port, row?.started])
    groups.set(key, [...groups.get(key) ?? [], target])
  }
  return [...groups.values()]
}

interface PostgresLedger {
  /** `created_at:hash` of each row. */
  keys: Set<string>
  lastApplied: number | undefined
}

/** Creates Drizzle Kit's ledger when it is missing, and reads it. Call it in the transaction that holds the lock. */
async function readPostgresLedger(sql: PostgresMigrationSql): Promise<PostgresLedger> {
  const keys = new Set<string>()
  for (const statement of createPostgresLedger) await sql.unsafe(statement)
  let lastApplied: number | undefined
  for (const row of Array.from(await sql.unsafe(`select hash, created_at from ${postgresLedger}`))) {
    const millis = Number(row.created_at ?? Number.NaN)
    if (!Number.isFinite(millis)) continue
    keys.add(`${millis}:${String(row.hash)}`)
    // Drizzle compares each journal `when` with the newest `created_at` only.
    lastApplied = Math.max(lastApplied ?? millis, millis)
  }
  return { keys, lastApplied }
}

/**
 * Lists the pending migrations of one Postgres database in the order they run, with the Definition of each. It keeps
 * Drizzle's rule: a migration is pending when its `when` is newer than the newest ledger row. Definitions that share the
 * database also share the ledger, and time alone cannot prove another Definition's history. So, as for a shared SQLite
 * file, it refuses a Definition's migration at or below the newest row that has no row of its own.
 */
function planPostgres(group: PostgresTarget[], { keys, lastApplied }: PostgresLedger, options: MigrateOnStartOptions) {
  const pending = new Map<string, { migration: StartMigration, name: string }>()
  for (const { database } of group) {
    if (group.length > 1 && lastApplied !== undefined) {
      const missing = database.migrations.find(migration => migration.when <= lastApplied && !keys.has(`${migration.when}:${migration.hash}`))
      if (missing) {
        throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({
          database: database.name,
          problem: `It shares its Postgres database with ${group.filter(target => target.database !== database).map(target => `"${target.database.name}"`).join(", ")}, and Drizzle's ledger there has no entry for migration "${missing.name}" at or below the latest applied timestamp. Drizzle would skip it. Give each Definition its own Postgres database, or move the migration after the latest applied one.`,
        })
      }
    }
    for (const migration of database.migrations) {
      const key = `${migration.when}:${migration.hash}`
      if ((lastApplied === undefined || lastApplied < migration.when) && !pending.has(key)) pending.set(key, { migration, name: database.name })
    }
  }
  const ordered = [...pending.values()].sort((a, b) => a.migration.when - b.migration.when)
  if (!options.allowDataLoss) {
    // Check the migrations in the order they run, so a table that this run creates can lose its rows.
    const checked = withoutNewTableDataLoss(ordered.map(({ migration }) => migration), "postgresql")
    for (const { database } of group) {
      const losses = checked.flatMap((migration, index) => ordered[index]!.name === database.name
        ? migration.dataLoss.map(loss => `${migration.name}: ${loss.reason}: ${loss.statement}`)
        : [])
      if (losses.length) throw databaseErrorDiagnostics.DATABASE_MIGRATION_DATA_LOSS({ database: database.name, statements: losses })
    }
  }
  return ordered
}

/** Runs `run` in a transaction that holds the migration lock of the group's database. */
async function withPostgresLock(group: PostgresTarget[], log: (message: string) => void, run: (sql: PostgresMigrationSql) => Promise<void>) {
  await group[0]!.client.begin(async (sql) => {
    const [lock] = Array.from(await sql.unsafe("select pg_try_advisory_xact_lock(hashtext($1)) as locked", [postgresMigrationLock]))
    if (lock?.locked !== true) {
      log(`[vitehub] Database "${group[0]!.database.name}": another process is applying migrations. Waiting for it to finish.`)
      await sql.unsafe("select pg_advisory_xact_lock(hashtext($1))", [postgresMigrationLock])
    }
    // postgres.js prints notices, such as "schema already exists, skipping", on stdout by default.
    await sql.unsafe("set local client_min_messages = warning")
    await run(sql)
  })
}

/** Holds the lock of every group, in order, for all of `run`. */
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
  const progress: { applied: Array<{ migration: StartMigration, name: string }>, running?: { migration: StartMigration, name: string } } = { applied: [] }
  try {
    await withPostgresLocks(groups, log, async (sqls) => {
      const plans: Array<Array<{ migration: StartMigration, name: string }>> = []
      for (const [index, group] of groups.entries()) plans.push(planPostgres(group, await readPostgresLedger(sqls[index]!), options))
      await options.beforeApply?.()
      for (const [index, pending] of plans.entries()) {
        for (const entry of pending) {
          progress.running = entry
          for (const statement of entry.migration.statements) await sqls[index]!.unsafe(statement)
          await sqls[index]!.unsafe(`insert into ${postgresLedger} ("hash", "created_at") values ($1, $2)`, [entry.migration.hash, entry.migration.when])
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
