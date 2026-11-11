import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { ledgerUpgradeProblem, matchLedger, toLedgerRow } from "../internal/migration-ledger.ts"
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
  // The hashes that the ledger stores for each applied folder name, including the names that the upgrade writes.
  const hashes = new Map<string, Set<string>>()
  const backfilled = new Map(match.backfill.map(({ row, name }) => [row, name]))
  for (const row of rows) {
    const name = row.name ?? backfilled.get(row)
    if (name) hashes.set(name, (hashes.get(name) ?? new Set()).add(row.hash))
  }
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

/**
 * Applies the pending migrations of each local SQLite database before the server handles requests. It uses Drizzle
 * Kit's ledger and refuses migrations that lose data, like `vitehub database migrate`. It checks every database before the
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
    // Separate clients and URL spellings can open the same file. SQLite reports the actual main database path.
    const files = await client.execute("PRAGMA database_list")
    const file = Array.from(files.rows).find(row => row[1] === "main")?.[2]
    // In-memory databases have no file path and belong only to their client.
    const target = typeof file === "string" && file ? file : client
    const plan = plans.get(target) ?? { client, databases: [], pending: [], upgrade: [] }
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
    const pending = new Map<string, { migration: StartMigration, name: string }>()
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
        if (!applied.has(migration.name) && !pending.has(migration.name)) pending.set(migration.name, { migration, name: database.name })
      }
    }
    // Check the migrations in the order they run on the file, so a table that this run creates can lose its rows.
    plan.pending = [...pending.values()].sort((a, b) => a.migration.when - b.migration.when || a.migration.name.localeCompare(b.migration.name))
    if (options.allowDataLoss) continue
    const checked = withoutNewTableDataLoss(plan.pending.map(({ migration }) => migration))
    for (const database of plan.databases) {
      const losses = checked.flatMap((migration, index) => plan.pending[index]!.name === database.name
        ? migration.dataLoss.map(loss => `${migration.name}: ${loss.reason}: ${loss.statement}`)
        : [])
      if (losses.length) throw databaseErrorDiagnostics.DATABASE_MIGRATION_DATA_LOSS({ database: database.name, statements: losses })
    }
  }
  for (const { client, pending, upgrade } of plans.values()) {
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
