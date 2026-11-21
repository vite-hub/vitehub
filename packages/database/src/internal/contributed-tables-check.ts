import { statSync } from "node:fs"

import { relative, resolve } from "pathe"

import { describeDatabaseContribution } from "../contributions.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { describeContributedMigration, planContributedMigrations } from "./contributed-migrations.ts"
import { migrationTableKey, readContributedMigrationHistory, readMigratedTables, sqliteIdentifier } from "./contributed-migration-history.ts"
import { loadContributedTableColumns } from "./schema-tables.ts"

import type { ResolvedDBViteConfig } from "../types.ts"

/**
 * Fails the build when the migrations of a Database do not create the tables and columns that Vite plugins contribute
 * to it, or do not hold their contributed SQL yet. The app did not write those tables, so it cannot see that a new
 * version of the plugin changed them. Without this check, the first request that uses them fails after the deploy.
 * Only report missing tables and columns when the generated history establishes what the migrations create.
 */
export async function assertContributedTablesGenerated(config: ResolvedDBViteConfig, options: { alias?: Record<string, string> } = {}): Promise<void> {
  const missing: string[] = []
  const databases: string[] = []
  const restore: string[] = []
  for (const name of config.databaseNames) {
    const database = config.databases[name]
    const tables = config.tableContributionsByDatabase[name] ?? []
    const migrations = config.migrationContributionsByDatabase[name] ?? []
    if (!database || (!tables.length && !migrations.length)) continue
    const migrationsDir = resolve(config.rootDir, database.migrationsDir)
    const before = missing.length
    const restoreBefore = restore.length
    const plan = planContributedMigrations(migrationsDir, migrations, database.dialect)
    for (const migration of plan.pending) missing.push(`the migration ${describeContributedMigration(migration)}`)
    const postgres = database.dialect === "postgresql"
    const d1 = !postgres && !!(database.cloudflare ?? config.definitionDefaults.cloudflare)
    const history = readContributedMigrationHistory(migrationsDir, d1)
    const missingSql = new Set(history.missingSql)
    for (const migration of plan.added) {
      const sql = resolve(migrationsDir, migration.folder, "migration.sql")
      if (!statSync(sql, { throwIfNoEntry: false })?.isFile()) missingSql.add(sql)
    }
    for (const sql of missingSql) restore.push(relative(config.rootDir, sql) || sql)
    const migrated = tables.length && !missingSql.size
      ? await readMigratedTables(history, new Set(plan.added.map(migration => migration.folder)), postgres)
      : undefined
    if (migrated) {
      for (const contribution of tables) {
        const owner = describeDatabaseContribution(contribution)
        const parent = config.generatedSchemaFilesByDatabase[name] ?? resolve(config.rootDir, "package.json")
        for (const { name: table, schema, columns } of await loadContributedTableColumns(contribution, parent, options)) {
          const created = migrated.get(migrationTableKey(table, postgres ? schema ?? "public" : undefined))
          const label = postgres && schema !== "public" ? `${schema ?? "public"}.${table}` : table
          if (!created) {
            missing.push(`the table "${label}" from ${owner}`)
            continue
          }
          const absent = columns.filter(column => !created.has(postgres ? column : sqliteIdentifier(column)))
          if (absent.length) missing.push(`the column${absent.length > 1 ? "s" : ""} ${absent.map(column => `"${column}"`).join(", ")} of the table "${label}" from ${owner}`)
        }
      }
    }
    if (missing.length > before || restore.length > restoreBefore) databases.push(`"${name}" (${relative(config.rootDir, migrationsDir) || migrationsDir})`)
  }
  if (missing.length || restore.length) throw databaseErrorDiagnostics.DATABASE_CONTRIBUTED_TABLES_NOT_GENERATED({ databases, missing, restore })
}
