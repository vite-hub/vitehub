import { resolve } from "pathe"

import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { readMigrations, readPendingMigration } from "./migration-journal.ts"

import type { StartMigration } from "../runtime/migrate-on-start.ts"
import type { DatabaseIntegrationOptions, ResolvedDBViteConfig } from "../types.ts"

/** The Nitro plugin that applies migrations at boot, relative to the Database project root. */
export const migrateOnStartPluginFile = ".vitehub/nitro/database/migrate-on-start.mjs"

export interface MigrateOnStartSettings {
  allowDataLoss: boolean
  /** The app set `migrateOnStart`. Without it, only Postgres databases of a Node build migrate on start. */
  explicit: boolean
}

/** `false` turns migrate on start off. Unset turns it on for Postgres databases only. */
export function resolveMigrateOnStart(options: false | Pick<DatabaseIntegrationOptions, "migrateOnStart"> | undefined): MigrateOnStartSettings | undefined {
  if (options === false) return
  const value = options?.migrateOnStart
  if (value === false) return
  if (value === undefined) return { allowDataLoss: false, explicit: false }
  return { allowDataLoss: value !== true && value.allowDataLoss === true, explicit: true }
}

/**
 * Returns the databases that the server migrates when it starts. An explicit `migrateOnStart` takes every database and
 * fails the build when one cannot migrate in the server process. The default takes the Postgres databases of a build
 * whose host is known to be Node, and nothing when the host is another one or unknown.
 */
export function selectMigrateOnStartDatabases(config: ResolvedDBViteConfig | undefined, settings: MigrateOnStartSettings, host: string | undefined): string[] {
  if (settings.explicit) {
    assertMigrateOnStartSupported(config, host)
    return config?.databaseNames ?? []
  }
  if (!config || host !== "node") return []
  return config.databaseNames.filter(name => config.databases[name]!.dialect === "postgresql")
}

interface RenderMigrateOnStartOptions {
  allowDataLoss: boolean
  /** The names that `selectMigrateOnStartDatabases()` returned. */
  databases: string[]
  /** Module that exports `useDatabase()` in the server build. */
  drizzleImport: string
  /** Module that exports `migrateOnStart()`. */
  runtimeImport: string
}

/**
 * Renders a Nitro plugin that applies each database's pending migrations before the server handles requests. The
 * migrations are read now and written into the plugin, so the server output does not need the migrations folder.
 * Returns `undefined` when no database has migrations.
 */
export function renderMigrateOnStartPlugin(config: ResolvedDBViteConfig, options: RenderMigrateOnStartOptions): string | undefined {
  const databases = options.databases
    .map(name => ({ dialect: config.databases[name]!.dialect, migrations: readStartMigrations(resolve(config.rootDir, config.databases[name]!.migrationsDir), name), name }))
    .filter(database => database.migrations.length)
  if (!databases.length) return
  return [
    `import { useDatabase } from ${JSON.stringify(options.drizzleImport)}`,
    `import { migrateOnStart } from ${JSON.stringify(options.runtimeImport)}`,
    "",
    "// Nitro imports plugins before it listens, so the server handles requests only after this finishes.",
    "// A failed migration rejects this import, and the server stops before it listens.",
    "// The prerender server runs during the build and must not migrate the runtime database.",
    "if (!import.meta.prerender) await migrateOnStart([",
    ...databases.map(database => `  { db: useDatabase(${JSON.stringify(database.name)}).db, dialect: ${JSON.stringify(database.dialect)}, migrations: ${JSON.stringify(database.migrations)}, name: ${JSON.stringify(database.name)} },`),
    `], { allowDataLoss: ${options.allowDataLoss} })`,
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

/** Reads the migration folders with the name, hash and timestamp that Drizzle's ledger stores. */
export function readStartMigrations(migrationsDir: string, database?: string): StartMigration[] {
  const entries = readMigrations(migrationsDir, database)
  return entries.map((entry) => {
    const { dataLoss, statements } = readPendingMigration(migrationsDir, entry.tag, entries)
    return { dataLoss, hash: entry.hash, name: entry.tag, statements, when: entry.when }
  })
}
