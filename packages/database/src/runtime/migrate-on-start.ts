import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { withoutNewTableDataLoss } from "../internal/migration-sql.ts"

import type { DataLossStatement } from "../internal/migration-sql.ts"

/** A Drizzle Kit migration, read at build time so the server output does not need the migrations folder. */
export interface StartMigration {
  dataLoss: DataLossStatement[]
  /** SHA-256 of the `.sql` file, the hash that Drizzle Kit's ledger stores. */
  hash: string
  name: string
  statements: string[]
  /** The journal `when`, which Drizzle Kit's ledger stores as `created_at`. */
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
  execute: (statement: LibsqlStatement) => Promise<{ rows: ArrayLike<ArrayLike<unknown>> }>
  migrate: (statements: LibsqlStatement[]) => Promise<unknown>
  protocol: string
}

interface StartMigrationPlan {
  client: LibsqlMigrationClient
  databases: StartMigrationDatabase[]
  pending: Map<string, { migration: StartMigration, name: string }>
}

// Drizzle Kit's ledger, created with the same statement as `drizzle-orm/libsql/migrator`, so `vitehub db migrate`
// and the server agree on what is applied.
const migrationsTable = "__drizzle_migrations"
const createMigrationsTable = `CREATE TABLE IF NOT EXISTS "${migrationsTable}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`

function isLibsqlClient(value: unknown): value is LibsqlMigrationClient {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "execute") === "function"
    && typeof Reflect.get(value, "migrate") === "function"
    && typeof Reflect.get(value, "protocol") === "string"
}

async function readApplied(client: LibsqlMigrationClient): Promise<{ keys: Set<string>, lastApplied: number | undefined }> {
  const keys = new Set<string>()
  let lastApplied: number | undefined
  const table = await client.execute({ args: [migrationsTable], sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?" })
  if (!table.rows.length) return { keys, lastApplied }
  const result = await client.execute(`SELECT hash, created_at FROM "${migrationsTable}"`)
  for (const row of Array.from(result.rows)) {
    if (row[1] === null || row[1] === undefined) continue
    const millis = Number(row[1])
    if (!Number.isFinite(millis)) continue
    keys.add(`${millis}:${row[0]}`)
    lastApplied = Math.max(lastApplied ?? millis, millis)
  }
  return { keys, lastApplied }
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
  // The lock is not held yet, so another server can change the ledger before the apply. The apply checks again.
  if (!options.allowDataLoss) {
    for (const { client, database } of postgres) {
      const lastApplied = await readPostgresLastApplied(client, { create: false })
      assertNoDataLoss(database.name, pendingAfter(database.migrations, lastApplied), "postgresql")
    }
  }
  await applySqlite(sqlitePlans, log)
  for (const { client, database } of postgres) await migratePostgres(client, database, { ...options, log })
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
    const plan = plans.get(target) ?? { client, databases: [], pending: new Map<string, { migration: StartMigration, name: string }>() }
    plan.databases.push(database)
    plans.set(target, plan)
  }
  for (const plan of plans.values()) {
    const { keys, lastApplied } = await readApplied(plan.client)
    for (const database of plan.databases) {
      // Keep Drizzle's timestamp selection, but a shared ledger cannot prove another journal's history by time alone.
      if (plan.databases.length > 1 && lastApplied !== undefined) {
        const missing = database.migrations.find(migration => migration.when <= lastApplied && !keys.has(`${migration.when}:${migration.hash}`))
        if (missing) {
          throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({
            database: database.name,
            problem: `Its shared SQLite file has no ledger entry for migration "${missing.name}" at or below the latest applied timestamp. Use compatible migration histories or separate SQLite files.`,
          })
        }
      }
      for (const migration of database.migrations) {
        const key = `${migration.when}:${migration.hash}`
        if ((lastApplied === undefined || lastApplied < migration.when) && !plan.pending.has(key)) plan.pending.set(key, { migration, name: database.name })
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
  for (const { client, pending: migrations } of plans) {
    if (!migrations.size) continue
    const pending = [...migrations.values()].sort((a, b) => a.migration.when - b.migration.when)
    await client.migrate([
      createMigrationsTable,
      ...pending.flatMap(({ migration }) => [
        ...migration.statements,
        { args: [migration.hash, migration.when], sql: `INSERT INTO "${migrationsTable}" ("hash", "created_at") VALUES (?, ?)` },
      ]),
    ])
    for (const { migration, name } of pending) log(`[vitehub] Database "${name}": applied ${migration.name}.`)
  }
}

function pendingAfter(migrations: StartMigration[], lastApplied: number | undefined): StartMigration[] {
  return migrations.filter(migration => lastApplied === undefined || lastApplied < migration.when)
}

function assertNoDataLoss(database: string, pending: StartMigration[], dialect: "postgresql" | "sqlite") {
  const losses = withoutNewTableDataLoss(pending, dialect).flatMap(migration => migration.dataLoss.map(loss => `${migration.name}: ${loss.reason}: ${loss.statement}`))
  if (losses.length) throw databaseErrorDiagnostics.DATABASE_MIGRATION_DATA_LOSS({ database, statements: losses })
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

async function readPostgresLastApplied(sql: PostgresMigrationSql, { create }: { create: boolean }): Promise<number | undefined> {
  if (create) {
    for (const statement of createPostgresLedger) await sql.unsafe(statement)
  }
  else {
    const [table] = Array.from(await sql.unsafe("select to_regclass('drizzle.__drizzle_migrations')::text as name"))
    if (!table?.name) return
  }
  // Drizzle compares each journal `when` with the newest `created_at` only.
  const [last] = Array.from(await sql.unsafe(`select created_at from ${postgresLedger} order by created_at desc limit 1`))
  const millis = Number(last?.created_at ?? Number.NaN)
  return Number.isFinite(millis) ? millis : undefined
}

/**
 * Applies the pending migrations of one Postgres database in one transaction. The transaction first takes the
 * advisory lock `postgresMigrationLock`, and only then reads Drizzle Kit's ledger. A second process waits for the lock
 * and then reads the ledger that the first one committed, so each migration runs once. The ledger rows are the ones
 * that drizzle-orm writes, so `drizzle-kit migrate` and ViteHub agree on what is applied.
 *
 * Returns the names of the applied migrations. A failed statement rolls back the transaction, so the database keeps
 * none of the pending migrations, and it throws `DATABASE_MIGRATION_FAILED`.
 */
export async function migratePostgres(
  client: PostgresMigrationClient,
  database: Pick<StartMigrationDatabase, "migrations" | "name">,
  options: MigrateOnStartOptions = {},
): Promise<string[]> {
  const log = options.log ?? (message => console.info(message))
  // The transaction callback sets these, so the catch can name the migration that failed.
  const progress: { applied: StartMigration[], running?: StartMigration } = { applied: [] }
  try {
    await client.begin(async (sql) => {
      const [lock] = Array.from(await sql.unsafe("select pg_try_advisory_xact_lock(hashtext($1)) as locked", [postgresMigrationLock]))
      if (lock?.locked !== true) {
        log(`[vitehub] Database "${database.name}": another process is applying migrations. Waiting for it to finish.`)
        await sql.unsafe("select pg_advisory_xact_lock(hashtext($1))", [postgresMigrationLock])
      }
      // postgres.js prints notices, such as "schema already exists, skipping", on stdout by default.
      await sql.unsafe("set local client_min_messages = warning")
      const pending = pendingAfter(database.migrations, await readPostgresLastApplied(sql, { create: true }))
      if (!options.allowDataLoss) assertNoDataLoss(database.name, pending, "postgresql")
      for (const migration of pending) {
        progress.running = migration
        for (const statement of migration.statements) await sql.unsafe(statement)
        await sql.unsafe(`insert into ${postgresLedger} ("hash", "created_at") values ($1, $2)`, [migration.hash, migration.when])
      }
      progress.running = undefined
      progress.applied = pending
    })
  }
  catch (error) {
    if (!progress.running) throw error
    throw databaseErrorDiagnostics.DATABASE_MIGRATION_FAILED({
      cause: error,
      database: database.name,
      migration: progress.running.name,
      problem: error instanceof Error ? error.message : String(error),
    })
  }
  for (const migration of progress.applied) log(`[vitehub] Database "${database.name}": applied ${migration.name}.`)
  return progress.applied.map(migration => migration.name)
}
