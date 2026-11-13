import { resolve } from "pathe"

import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { readMigrations, readPendingMigration } from "./migration-journal.ts"

import type { MigrationBackup, StartMigration } from "../runtime/migrate-on-start.ts"
import type { DatabaseIntegrationOptions, MigrationBackupOptions, ResolvedDBViteConfig } from "../types.ts"

/** The Nitro plugin that applies migrations at boot, relative to the Database project root. */
export const migrateOnStartPluginFile = ".vitehub/nitro/database/migrate-on-start.mjs"

export interface MigrateOnStartSettings {
  allowDataLoss: boolean
  backup?: MigrationBackup
  /** The app set `migrateOnStart`. Without it, only Postgres databases of a Node build migrate on start. */
  explicit: boolean
}

/** `false` turns migrate on start off. Unset turns it on for Postgres databases only. */
export function resolveMigrateOnStart(options: false | Pick<DatabaseIntegrationOptions, "migrateOnStart"> | undefined): MigrateOnStartSettings | undefined {
  if (options === false) return
  const value = options?.migrateOnStart
  if (value === false) return
  if (value === undefined) return { allowDataLoss: false, explicit: false }
  if (value === true) return { allowDataLoss: false, explicit: true }
  const backup = resolveMigrationBackup(value.backup)
  return { allowDataLoss: value.allowDataLoss === true, ...backup && { backup }, explicit: true }
}

function resolveMigrationBackup(value: boolean | MigrationBackupOptions | undefined): MigrationBackup | undefined {
  if (!value) return
  if (value === true) return { keep: 3 }
  const keep = value.keep ?? 3
  if (!Number.isInteger(keep) || keep < 1) {
    throw databaseErrorDiagnostics.DATABASE_MIGRATION_BACKUP_UNSUPPORTED({ problem: `\`keep\` is ${JSON.stringify(keep)}, and must be a whole number of 1 or more.` })
  }
  return { ...value.dir && { dir: value.dir }, keep }
}

/**
 * Returns the databases that the server migrates when it starts. An explicit `migrateOnStart` takes every database and
 * fails the build when one cannot migrate in the server process. The default takes the Postgres databases of a build
 * whose host is known to be Node, and nothing when the host is another one or unknown.
 */
export function selectMigrateOnStartDatabases(config: ResolvedDBViteConfig | undefined, settings: MigrateOnStartSettings, host: string | undefined): string[] {
  if (settings.explicit) {
    assertMigrateOnStartSupported(config, host)
    if (settings.backup) assertMigrationBackupSupported(config)
    return config?.databaseNames ?? []
  }
  if (!config || host !== "node") return []
  return config.databaseNames.filter(name => config.databases[name]!.dialect === "postgresql")
}

interface RenderMigrateOnStartOptions {
  /** The names that `selectMigrateOnStartDatabases()` returned. */
  databases: string[]
  /** Module that exports `databases` in the server build. */
  registryImport: string
  /** Module that `renderShippedMigrationsModule()` wrote. */
  migrationsImport: string
  /** Module that exports `ensureDatabaseMigrations()`. */
  runtimeImport: string
}

/**
 * Renders the module of migrations that the server build ships, for the start plugin and `ensureMigrations()`. The
 * migrations are read now, so the server output does not need the migrations folder. A folder that cannot be read
 * fails only the call that needs it, so a build that never migrates in the server does not fail.
 */
export function renderShippedMigrationsModule(config: ResolvedDBViteConfig | undefined, settings: Pick<MigrateOnStartSettings, "allowDataLoss" | "backup"> | undefined): string {
  const databases: Record<string, { dialect: string, migrations: StartMigration[] } | { problem: string }> = {}
  for (const name of config?.databaseNames ?? []) {
    try {
      const migrations = readStartMigrations(resolve(config!.rootDir, config!.databases[name]!.migrationsDir), name)
      if (migrations.length) databases[name] = { dialect: config!.databases[name]!.dialect, migrations }
    }
    catch (error) {
      databases[name] = { problem: error instanceof Error ? error.message : String(error) }
    }
  }
  return `export default ${JSON.stringify({ allowDataLoss: settings?.allowDataLoss ?? false, ...settings?.backup && { backup: settings.backup }, databases })}\n`
}

/**
 * Renders a Nitro plugin that applies each database's pending migrations before the server handles requests. It shares
 * the run of `ensureMigrations()`, so a later call in the same process finds the migrations applied. Returns `undefined`
 * when no database has migrations.
 */
export function renderMigrateOnStartPlugin(config: ResolvedDBViteConfig, options: RenderMigrateOnStartOptions): string | undefined {
  const databases = options.databases.filter(name => readStartMigrations(resolve(config.rootDir, config.databases[name]!.migrationsDir), name).length)
  if (!databases.length) return
  return [
    `import { databases } from ${JSON.stringify(options.registryImport)}`,
    `import { ensureDatabaseMigrations } from ${JSON.stringify(options.runtimeImport)}`,
    `import migrations from ${JSON.stringify(options.migrationsImport)}`,
    "",
    "// Nitro imports plugins before it listens, so the server handles requests only after this finishes.",
    "// A failed migration rejects this import, and the server stops before it listens.",
    "// The prerender server runs during the build and must not migrate the runtime database.",
    `if (!import.meta.prerender) await ensureDatabaseMigrations({ databases, load: async () => migrations }, ${JSON.stringify(databases)})`,
    "",
    "export default () => {}",
    "",
  ].join("\n")
}

/** Fails the build when a database cannot migrate in the server process. `host` is `undefined` or `node` for Node. */
export function assertMigrateOnStartSupported(config: ResolvedDBViteConfig | undefined, host: string | undefined) {
  if (host && host !== "node") {
    throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({ problem: `The build targets ${host}.` })
  }
  if (!config) return
  for (const name of config.databaseNames) {
    if (config.databases[name]!.cloudflare?.http) {
      throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({ database: name, problem: "It uses Cloudflare D1 over HTTP." })
    }
  }
}

/**
 * Fails the build when `migrateOnStart.backup` cannot copy a database: a Postgres database, or a SQLite database whose
 * `connection.url` is remote libSQL or in memory. A URL from the environment is checked when the server starts.
 */
function assertMigrationBackupSupported(config: ResolvedDBViteConfig | undefined) {
  for (const name of config?.databaseNames ?? []) {
    const database = config!.databases[name]!
    if (database.dialect === "postgresql") {
      throw databaseErrorDiagnostics.DATABASE_MIGRATION_BACKUP_UNSUPPORTED({ database: name, problem: "It is a Postgres database." })
    }
    const url = database.connection?.url
    if (typeof url === "string" && (url === ":memory:" || /^(?:libsql|https?|wss?):/i.test(url))) {
      throw databaseErrorDiagnostics.DATABASE_MIGRATION_BACKUP_UNSUPPORTED({ database: name, problem: url === ":memory:" ? "It is in memory." : "It uses remote libSQL." })
    }
  }
}

/** Reads the migration folders with the name, hash and timestamp that Drizzle's ledger stores. */
export function readStartMigrations(migrationsDir: string, database?: string): StartMigration[] {
  const entries = readMigrations(migrationsDir, database)
  return entries.map((entry) => {
    const { dataLoss, statements } = readPendingMigration(migrationsDir, entry.tag, entries)
    return { dataLoss, hash: entry.hash, name: entry.tag, statements, when: entry.when }
  })
}
