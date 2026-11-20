import { existsSync, readdirSync } from "node:fs"

import { relative, resolve } from "pathe"

import { describeDatabaseContribution } from "../contributions.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { describeContributedMigration, planContributedMigrations } from "./contributed-migrations.ts"
import { readSnapshotTables } from "./migration-journal.ts"
import { loadContributedTableColumns } from "./schema-tables.ts"

import type { ResolvedDBViteConfig } from "../types.ts"
import type { TableColumns } from "./migration-sql.ts"

/**
 * The tables and columns that a migrations folder creates: the Drizzle snapshot of its newest migration. A folder that
 * does not exist creates nothing. `undefined` when the newest migration has no snapshot, such as a hand-written SQL
 * file, so the tables are not known. Contributed SQL folders are skipped: `vitehub database generate` writes them
 * after the snapshot of the same run.
 */
function readMigratedTables(migrationsDir: string, contributed: ReadonlySet<string>): TableColumns | undefined {
  if (!existsSync(migrationsDir)) return new Map()
  const entries = readdirSync(migrationsDir, { withFileTypes: true })
  if (entries.some(entry => entry.isFile() && entry.name.endsWith(".sql"))) return undefined
  const folders = entries.filter(entry => entry.isDirectory() && /^\d{14}_/.test(entry.name)).map(entry => entry.name).sort().reverse()
  for (const folder of folders) {
    if (contributed.has(folder)) continue
    return readSnapshotTables(migrationsDir, folder)?.columns
  }
  return new Map()
}

/**
 * Fails the build when the migrations of a Database do not create the tables and columns that Vite plugins contribute
 * to it, or do not hold their contributed SQL yet. The app did not write those tables, so it cannot see that a new
 * version of the plugin changed them. Without this check, the first request that uses them fails after the deploy.
 * Only `vitehub database generate` adds them, so a Database whose newest migration has no snapshot is not checked.
 */
export async function assertContributedTablesGenerated(config: ResolvedDBViteConfig, options: { alias?: Record<string, string> } = {}): Promise<void> {
  const missing: string[] = []
  const databases: string[] = []
  for (const name of config.databaseNames) {
    const database = config.databases[name]
    const tables = config.tableContributionsByDatabase[name] ?? []
    const migrations = config.migrationContributionsByDatabase[name] ?? []
    if (!database || (!tables.length && !migrations.length)) continue
    const migrationsDir = resolve(config.rootDir, database.migrationsDir)
    const before = missing.length
    const plan = planContributedMigrations(migrationsDir, migrations, database.dialect)
    for (const migration of plan.pending) missing.push(`the migration ${describeContributedMigration(migration)}`)
    const migrated = readMigratedTables(migrationsDir, new Set(plan.added.map(migration => migration.folder)))
    if (migrated) {
      for (const contribution of tables) {
        const owner = describeDatabaseContribution(contribution)
        const parent = config.generatedSchemaFilesByDatabase[name] ?? resolve(config.rootDir, "package.json")
        for (const [table, columns] of await loadContributedTableColumns(contribution, parent, options)) {
          const created = migrated.get(table.toLowerCase())
          if (!created) {
            missing.push(`the table "${table}" from ${owner}`)
            continue
          }
          const absent = columns.filter(column => !created.includes(column))
          if (absent.length) missing.push(`the column${absent.length > 1 ? "s" : ""} ${absent.map(column => `"${column}"`).join(", ")} of the table "${table}" from ${owner}`)
        }
      }
    }
    if (missing.length > before) databases.push(`"${name}" (${relative(config.rootDir, migrationsDir) || migrationsDir})`)
  }
  if (missing.length) throw databaseErrorDiagnostics.DATABASE_CONTRIBUTED_TABLES_NOT_GENERATED({ databases, missing })
}
