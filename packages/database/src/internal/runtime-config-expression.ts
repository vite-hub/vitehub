import { resolve } from "pathe"

import { localPgliteDir } from "../runtime/local-path.ts"

import type { PgliteOptions } from "../runtime/pglite.ts"
import type { PostgresDatabaseDefaults } from "../runtime/postgres.ts"
import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"

function renderConfigExpression(value: unknown) {
  return typeof value === "undefined" ? "undefined" : JSON.stringify(value)
}

function serializeDatabaseConfig({ cloudflare: _cloudflare, connection: _connection, ...database }: ResolvedDrizzleDatabaseConfig) {
  return JSON.stringify(database, null, 4)
}

export function renderDatabaseConfigExpression(name: string, config: ResolvedDBViteConfig, definitionVariable: string, localLimits?: "d1") {
  const base = config.databases[name]!
  const cloudflare = base.cloudflare ?? config.definitionDefaults.cloudflare
  const cloudflareOptions = { ...config.definitionDefaults.cloudflareProjections?.[name], migrationsDir: base.migrationsDir, name }
  return [
    "{",
    `      ...${serializeDatabaseConfig(base)},`,
    `      cloudflare: resolveRuntimeCloudflareConfig(${renderConfigExpression(cloudflare)}, ${definitionVariable}.cloudflare, ${renderConfigExpression(cloudflareOptions)}),`,
    `      connection: ${definitionVariable}.connection ? { authToken: ${definitionVariable}.connection.authToken ?? ${renderConfigExpression(base.connection?.authToken)}, url: ${definitionVariable}.connection.url ?? ${renderConfigExpression(base.connection?.url)} } : ${renderConfigExpression(base.connection)},`,
    ...(localLimits ? [`      localLimits: ${JSON.stringify(localLimits)},`] : []),
    "    }",
  ].join("\n")
}

/**
 * Renders the `createPostgresDatabase()` call for a Postgres Definition in a generated runtime module.
 * `schemaExpression` and `relationsExpression` are the merged schema and relations, because Nuxt layers and contributed
 * tables add tables and relations that the evaluated Definition does not hold. A development module renders
 * `createDevPostgresDatabase()` instead, which can run the Database on PGlite. It is awaited at the top level.
 */
export function renderPostgresDatabaseExpression(name: string, config: ResolvedDBViteConfig, definitionVariable: string, schemaExpression: string, relationsExpression: string, dev = false) {
  const database = config.databases[name]!
  const defaults: PostgresDatabaseDefaults = { binding: database.hyperdrive?.binding ?? "HYPERDRIVE" }
  if (database.connection?.url !== undefined) defaults.url = database.connection.url
  const definition = `{ ...${definitionVariable}, relations: ${relationsExpression}, schema: ${schemaExpression} }`
  if (!dev) return `createPostgresDatabase(${definition}, ${JSON.stringify(defaults)})`
  const pglite: PgliteOptions = { dataDir: resolve(config.rootDir, localPgliteDir(name)), migrationsDir: resolve(config.rootDir, database.migrationsDir) }
  return `await createDevPostgresDatabase(${definition}, ${JSON.stringify(defaults)}, ${JSON.stringify(pglite)})`
}

/** Lists the Postgres Databases that set `driver: "pglite"`. A production build fails with them. */
export function pgliteDatabases(config: ResolvedDBViteConfig) {
  return config.databaseNames.filter(name => config.databases[name]?.driver === "pglite")
}

export function usesPostgres(config: ResolvedDBViteConfig) {
  return config.databaseNames.some(name => config.databases[name]?.dialect === "postgresql")
}

export function usesD1ReadReplication(config: ResolvedDBViteConfig) {
  return config.databaseNames.some(name => {
    const cloudflare = config.databases[name]?.cloudflare
    const projection = config.definitionDefaults.cloudflareProjections?.[name]
    // Opaque Definition values can enable read replication at runtime. Install
    // the request scope for native D1 unless the option is known to be false;
    // HTTP-backed D1 does not use the Sessions API.
    return cloudflare !== undefined && cloudflare.http === undefined
      && (cloudflare.readReplication === true || projection?.resource === "opaque" || projection?.readReplication === "opaque")
  })
}

export function usesSqlite(config: ResolvedDBViteConfig) {
  return config.databaseNames.some(name => config.databases[name]?.dialect !== "postgresql")
}
