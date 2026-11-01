import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import { join, resolve } from "pathe"

import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { readJournal, readPendingMigration } from "./migration-journal.ts"

import type { StartMigration } from "../runtime/migrate-on-start.ts"
import type { DatabaseIntegrationOptions, ResolvedDBViteConfig } from "../types.ts"

/** The Nitro plugin that applies migrations at boot, relative to the Database project root. */
export const migrateOnStartPluginFile = ".vitehub/nitro/database/migrate-on-start.mjs"

export interface MigrateOnStartSettings {
  allowDataLoss: boolean
}

export function resolveMigrateOnStart(options: false | Pick<DatabaseIntegrationOptions, "migrateOnStart"> | undefined): MigrateOnStartSettings | undefined {
  const value = options ? options.migrateOnStart : undefined
  if (!value) return
  return { allowDataLoss: value !== true && value.allowDataLoss === true }
}

interface RenderMigrateOnStartOptions extends MigrateOnStartSettings {
  /** Module that exports `useDatabase()` in the server build. */
  drizzleImport: string
  /** The host that the build targets, from `resolveHost()`. */
  host: string | undefined
  /** Module that exports `migrateOnStart()`. */
  runtimeImport: string
}

/**
 * Renders a Nitro plugin that applies each database's pending migrations before the server handles requests. The
 * migrations are read now and written into the plugin, so the server output does not need the migrations folder.
 */
export function renderMigrateOnStartPlugin(config: ResolvedDBViteConfig, options: RenderMigrateOnStartOptions): string {
  assertMigrateOnStartSupported(config, options.host)
  const databases = config.databaseNames
    .map(name => ({ migrations: readStartMigrations(resolve(config.rootDir, config.databases[name]!.migrationsDir)), name }))
    .filter(database => database.migrations.length)
  return [
    `import { useDatabase } from ${JSON.stringify(options.drizzleImport)}`,
    `import { migrateOnStart } from ${JSON.stringify(options.runtimeImport)}`,
    "",
    "// Nitro imports plugins before it listens, so the server handles requests only after this finishes.",
    "await migrateOnStart([",
    ...databases.map(database => `  { db: useDatabase(${JSON.stringify(database.name)}).db, migrations: ${JSON.stringify(database.migrations)}, name: ${JSON.stringify(database.name)} },`),
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
    const database = config.databases[name]!
    if (database.dialect === "postgresql") {
      throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({ database: name, problem: "It is a Postgres database." })
    }
    if (database.cloudflare?.http) {
      throw databaseErrorDiagnostics.DATABASE_MIGRATE_ON_START_UNSUPPORTED({ database: name, problem: "It uses Cloudflare D1 over HTTP." })
    }
  }
}

function readStartMigrations(migrationsDir: string): StartMigration[] {
  const entries = readJournal(migrationsDir)
  return entries.map((entry) => {
    const { dataLoss, statements } = readPendingMigration(migrationsDir, entry.tag, entries)
    const hash = createHash("sha256").update(readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8")).digest("hex")
    return { dataLoss, hash, name: entry.tag, statements, when: entry.when }
  })
}
