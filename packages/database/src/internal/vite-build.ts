import { mkdir, writeFile } from "node:fs/promises"

import { computePackageDir, createImportPath, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vite-hub/internal/build/paths"
import { readProvisionedId } from "@vite-hub/internal/provision-state"
import { resolve } from "pathe"

import { resolveConfigValue } from "../config-value.ts"
import { isImplicitDefaultDatabase, isStaticD1HttpDefinition, mayUseRemoteLibsql, serializeGeneratedRegistry } from "../config.ts"
import { implicitDefaultDatabaseContributions } from "../contributions.ts"
import { resolveCloudflareD1Bindings } from "./cloudflare.ts"
import { renderDatabaseRuntimeModule } from "./runtime-module.ts"
import { renderDatabaseConfigExpression, renderPostgresDatabaseExpression, usesPostgres, usesSqlite } from "./runtime-config-expression.ts"

import type { ProvisionState } from "@vite-hub/internal/provision"
import type { CollectedDatabaseContributions } from "../contributions.ts"
import type { DatabaseConfigValue, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

export const dbPackageName = "@vite-hub/database"
const packageDir = computePackageDir(import.meta.url)
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)

export type DBProvider = "cloudflare" | "vercel"

function normalizeDefinitionDefaults(defaults: ResolvedDBViteConfig["definitionDefaults"]): ResolvedDBViteConfig["definitionDefaults"] {
  if (!defaults.cloudflare || defaults.cloudflare.binding === undefined) return defaults
  return {
    ...defaults,
    cloudflare: {
      ...defaults.cloudflare,
      binding: defaults.cloudflare.binding.trim() || undefined,
    },
  }
}

export function usesD1HttpOnly(runtimeConfig: ResolvedDBViteConfig) {
  return runtimeConfig.databaseNames.length > 0
    && runtimeConfig.databaseNames.every(name => Boolean(runtimeConfig.databases[name]?.cloudflare?.http))
    && runtimeConfig.definitions.every(definition => isStaticD1HttpDefinition(definition.handler))
}

/**
 * Reports whether a SQLite Database of the app can query a libSQL server. A hosted runtime opens libSQL only for a
 * remote URL, so without one the build ships no libSQL client: a Cloudflare build then reaches its Databases through
 * D1 only.
 */
export function usesRemoteLibsql(runtimeConfig: ResolvedDBViteConfig): boolean {
  return runtimeConfig.definitions.some((definition) => {
    const database = runtimeConfig.databases[definition.name]
    return database?.dialect !== "postgresql" && (!database || mayUseRemoteLibsql(definition.handler, database))
  })
}

function renderRuntimeModule(file: string, runtimeConfig: ResolvedDBViteConfig, provider: DBProvider) {
  const imports = runtimeConfig.definitions.flatMap((definition, index) => [
    `import definition_${index} from ${JSON.stringify(createImportPath(file, definition.handler))}`,
    `import schema_${index}, { relations as relations_${index} } from ${JSON.stringify(createImportPath(file, runtimeConfig.generatedSchemaFilesByDatabase[definition.name]!))}`,
  ])
  const databaseEntries = runtimeConfig.databaseNames.map((name, index) => [
    `  [${JSON.stringify(name)}]: {`,
    runtimeConfig.databases[name]?.dialect === "postgresql"
      ? `    db: ${renderPostgresDatabaseExpression(name, runtimeConfig, `definition_${index}`, `schema_${index}`, `relations_${index}`)},`
      : `    db: createHostedDrizzleDb(${renderDatabaseConfigExpression(name, runtimeConfig, `definition_${index}`)}, relations_${index}),`,
    `    relations: relations_${index},`,
    `    schema: schema_${index},`,
    "  },",
  ].join("\n"))

  return renderDatabaseRuntimeModule({
    chunkParametersImport: createImportPath(file, resolveRuntimeModule("runtime/chunk-parameters")),
    createAgentDatabaseImport: createImportPath(file, resolveRuntimeModule("runtime/agent")),
    databaseEntries,
    ensureMigrationsImport: createImportPath(file, resolveRuntimeModule("runtime/migrate-on-start")),
    imports: [
      ...(usesSqlite(runtimeConfig) ? [`import { createHostedDrizzleDb, resolveRuntimeCloudflareConfig } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule(usesRemoteLibsql(runtimeConfig) ? "runtime/hosted" : "runtime/d1")))}`] : []),
      ...(usesPostgres(runtimeConfig) ? [`import { createPostgresDatabase } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/postgres")))}`] : []),
      "",
      ...imports,
    ],
    migrations: { unsupported: `The build targets ${provider}.` },
    useDatabaseImport: createImportPath(file, resolveRuntimeModule("runtime/use-database")),
  })
}

/** Fails when a Cloudflare runtime module would hold a native D1 Database without a resolved resource. */
export function assertHostedDatabaseRuntimeResources(runtimeConfig: ResolvedDBViteConfig, providers: readonly DBProvider[] = ["cloudflare", "vercel"]) {
  if (!providers.includes("cloudflare")) return
  const unprojectedNativeDatabases = runtimeConfig.databaseNames.filter((name) => {
    const database = runtimeConfig.databases[name]
    if (database?.dialect === "postgresql") return false
    const projection = runtimeConfig.definitionDefaults.cloudflareProjections?.[name]
    const cloudflare = database?.cloudflare ?? runtimeConfig.definitionDefaults.cloudflare
    return (projection?.resource === "opaque" || (projection?.resource === "configured" && !projection.binding))
      && cloudflare && !cloudflare.http && !isRemoteLibsqlConnectionUrl(database?.connection?.url)
  })
  if (unprojectedNativeDatabases.length) {
    const opaqueNativeDatabases = unprojectedNativeDatabases.filter(name => runtimeConfig.definitionDefaults.cloudflareProjections[name]?.resource === "opaque")
    if (opaqueNativeDatabases.length) {
      throw databaseErrorDiagnostics.DATABASE_OPAQUE_CLOUDFLARE_CONFIG({ databases: opaqueNativeDatabases })
    }
    throw databaseErrorDiagnostics.DATABASE_MISSING_D1_RESOURCE({ databases: unprojectedNativeDatabases, missing: "resolved `cloudflare.databaseId` and `cloudflare.databaseName` values" })
  }
  resolveCloudflareD1Bindings(runtimeConfig)
}

/**
 * Writes hosted modules before a framework resolves its generated runtime aliases. A build calls
 * `assertHostedDatabaseRuntimeResources` first; `nuxt prepare` writes the modules for types without the check.
 */
export async function writeHostedDatabaseRuntimeModules(
  generatedDir: string,
  runtimeConfig: ResolvedDBViteConfig,
  providers: readonly DBProvider[] = ["cloudflare", "vercel"],
) {
  const definitionDefaults = normalizeDefinitionDefaults(runtimeConfig.definitionDefaults)
  const normalizedRuntimeConfig = { ...runtimeConfig, definitionDefaults }
  const definitionDefaultsFile = resolve(generatedDir, "definition-defaults.mjs")
  await mkdir(generatedDir, { recursive: true })
  await Promise.all([
    writeFile(definitionDefaultsFile, `export default ${serializeGeneratedRegistry(definitionDefaults)}\n`, "utf8"),
    ...providers.map(async (provider) => {
      const file = resolve(generatedDir, `${provider}-runtime.mjs`)
      await writeFile(file, renderRuntimeModule(file, normalizedRuntimeConfig, provider), "utf8")
    }),
  ])
  return definitionDefaultsFile
}

// Explicit env-resolved id wins; otherwise fall back to a provisioned id from Provision State.
function resolveDatabaseId(runtimeConfig: ResolvedDBViteConfig, name: string, provisionState: ProvisionState): string | undefined {
  return resolveConfigValue(runtimeConfig.databases[name]?.cloudflare?.databaseId)
    ?? readProvisionedId(provisionState, "cloudflare", "d1", name)
}

function isRemoteLibsqlConnectionUrl(value: DatabaseConfigValue | undefined) {
  const url = resolveConfigValue(value)
  return typeof url === "string"
    ? /^(?:libsql:|https?:\/\/)/i.test(url)
    : typeof value !== "undefined"
}

function hasConfigValue(value: DatabaseConfigValue | undefined) {
  const databaseId = resolveConfigValue(value)
  return typeof databaseId === "string"
    ? Boolean(databaseId.trim())
    : typeof value !== "undefined"
}

// A Postgres Definition runs on Cloudflare through a generated Hyperdrive binding or a direct connection URL.
function hasCloudflarePostgresConnection(database: ResolvedDBViteConfig["databases"][string]) {
  return hasConfigValue(database.hyperdrive?.hyperdriveId) || hasConfigValue(database.connection?.url)
}

function getCloudflareUnsupportedDatabases(runtimeConfig: ResolvedDBViteConfig, provisionState: ProvisionState) {
  return runtimeConfig.databaseNames.filter((name) => {
    const database = runtimeConfig.databases[name]
    if (database?.dialect === "postgresql") return !hasCloudflarePostgresConnection(database)
    const hasD1Binding = hasConfigValue(resolveDatabaseId(runtimeConfig, name, provisionState))
    return !hasD1Binding && !isRemoteLibsqlConnectionUrl(database?.connection?.url)
  })
}

function getCloudflareDatabasesMissingNames(runtimeConfig: ResolvedDBViteConfig, provisionState: ProvisionState) {
  return runtimeConfig.databaseNames.filter((name) => {
    const database = runtimeConfig.databases[name]
    if (database?.dialect === "postgresql") return false
    const cloudflare = runtimeConfig.databases[name]?.cloudflare
    return hasConfigValue(resolveDatabaseId(runtimeConfig, name, provisionState))
      && !hasConfigValue(resolveConfigValue(cloudflare?.databaseName))
      && !cloudflare?.http
      && !isRemoteLibsqlConnectionUrl(database?.connection?.url)
  })
}

function getVercelUnsupportedDatabases(runtimeConfig: ResolvedDBViteConfig) {
  return runtimeConfig.databaseNames.filter((name) => {
    const database = runtimeConfig.databases[name]
    if (database?.dialect === "postgresql") return !hasConfigValue(database.connection?.url)
    const hasD1Http = Boolean(database?.cloudflare?.http)
      && hasConfigValue(database.cloudflare?.databaseId)
    return !hasD1Http
      && !isRemoteLibsqlConnectionUrl(database?.connection?.url)
  })
}

/**
 * Fails a Cloudflare build for a SQLite Definition without a D1 resource, including bindings the host could not resolve.
 * The implicit default Database is checked only when a contributed table or use needs it: an app can enable `database`
 * and never query it. Nuxt checks incomplete bindings separately against its host resource.
 */
export function assertDefinitionD1Resources(runtimeConfig: ResolvedDBViteConfig, contributions: CollectedDatabaseContributions, unresolvedDatabases: readonly string[] = []) {
  const implicitDefaultUsed = implicitDefaultDatabaseContributions(contributions).length > 0
  const databases = runtimeConfig.definitions.filter((definition) => {
    const database = runtimeConfig.databases[definition.name]!
    return (implicitDefaultUsed || !isImplicitDefaultDatabase(definition)) && database.dialect === "sqlite" && (!database.cloudflare || unresolvedDatabases.includes(definition.name)) && !hasRemoteDefinitionRuntime(database)
  }).map(definition => definition.name)
  if (!databases.length) return
  // The implicit default Database has no Definition file, so it takes its D1 resource from the module options.
  const options = runtimeConfig.definitions.some(isImplicitDefaultDatabase) ? "database" : "cloudflare"
  throw databaseErrorDiagnostics.DATABASE_MISSING_D1_RESOURCE({ databases, missing: `\`${options}.databaseName\`, and \`${options}.databaseId\` or provision state,` })
}

/** Reports whether a Definition reaches its database over the network: D1 HTTP or a remote libSQL URL. */
export function hasRemoteDefinitionRuntime(database: ResolvedDrizzleDatabaseConfig) {
  if (database.cloudflare?.http) return true
  const url = resolveConfigValue(database.connection?.url)
  return typeof url === "string" && /^(?:libsql:|https?:\/\/|wss?:\/\/)/i.test(url)
}

/** Reports whether the hosted runtime module can serve every configured database on the provider. */
export function supportsHostedDatabaseRuntime(provider: DBProvider, runtimeConfig: ResolvedDBViteConfig, provisionState: ProvisionState) {
  return provider === "cloudflare"
    ? getCloudflareUnsupportedDatabases(runtimeConfig, provisionState).length === 0
      && getCloudflareDatabasesMissingNames(runtimeConfig, provisionState).length === 0
    : getVercelUnsupportedDatabases(runtimeConfig).length === 0
}
