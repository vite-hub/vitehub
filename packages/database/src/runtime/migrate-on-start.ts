import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

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

async function readLastApplied(client: LibsqlMigrationClient): Promise<number | undefined> {
  const table = await client.execute({ args: [migrationsTable], sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?" })
  if (!table.rows.length) return
  const result = await client.execute(`SELECT created_at FROM "${migrationsTable}" ORDER BY created_at DESC LIMIT 1`)
  const value = result.rows[0]?.[0]
  if (value === null || value === undefined) return
  const millis = Number(value)
  return Number.isFinite(millis) ? millis : undefined
}

/**
 * Applies the pending migrations of each local SQLite database before the server handles requests. It uses Drizzle
 * Kit's ledger and refuses migrations that lose data, like `vitehub db migrate`. It checks every database before the
 * first one changes, so a refusal leaves all of them as they were. All pending migrations of one SQLite file run in one
 * transaction, so a failure keeps none of them.
 */
export async function migrateOnStart(databases: StartMigrationDatabase[], options: MigrateOnStartOptions = {}): Promise<void> {
  const log = options.log ?? (message => console.info(message))
  const plans = new Map<string | LibsqlMigrationClient, StartMigrationPlan>()
  for (const database of databases) {
    const client: unknown = Reflect.get(Object(database.db), "$client")
    if (!isLibsqlClient(client) || client.protocol !== "file") {
      const target = isLibsqlClient(client) ? `libSQL over ${client.protocol}` : "a connection that is not libSQL"
      throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({ database: database.name, problem: `It uses ${target}.` })
    }
    const lastApplied = await readLastApplied(client)
    const pending = database.migrations.filter(migration => lastApplied === undefined || lastApplied < migration.when)
    const losses = pending.flatMap(migration => migration.dataLoss.map(loss => `${migration.name}: ${loss.reason}: ${loss.statement}`))
    if (losses.length && !options.allowDataLoss) {
      throw databaseErrorDiagnostics.DATABASE_MIGRATION_DATA_LOSS({ database: database.name, statements: losses })
    }
    if (!pending.length) continue
    // Separate clients and URL spellings can open the same file. SQLite reports the actual main database path.
    const files = await client.execute("PRAGMA database_list")
    const file = Array.from(files.rows).find(row => row[1] === "main")?.[2]
    // In-memory databases have no file path and belong only to their client.
    const target = typeof file === "string" && file ? file : client
    const plan = plans.get(target) ?? { client, pending: new Map<string, { migration: StartMigration, name: string }>() }
    for (const migration of pending) {
      const key = `${migration.when}:${migration.hash}`
      if (!plan.pending.has(key)) plan.pending.set(key, { migration, name: database.name })
    }
    plans.set(target, plan)
  }
  for (const { client, pending: migrations } of plans.values()) {
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
