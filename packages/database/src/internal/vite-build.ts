import { mkdir, writeFile } from "node:fs/promises"

import { computePackageDir, createImportPath, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vite-hub/internal/build/paths"
import { readProvisionedId } from "@vite-hub/internal/provision-state"
import { resolve } from "pathe"

import { resolveConfigValue } from "../config-value.ts"
import { isStaticD1HttpDefinition, serializeGeneratedRegistry } from "../config.ts"
import { resolveCloudflareD1Bindings, resolveCloudflareHyperdriveBindings } from "./cloudflare.ts"
import { renderDatabaseRuntimeModule } from "./runtime-module.ts"
import { renderDatabaseConfigExpression, renderPostgresDatabaseExpression, usesPostgres, usesSqlite } from "./runtime-config-expression.ts"

import type { ProvisionState } from "@vite-hub/internal/provision"
import type { DatabaseConfigValue, ResolvedDBViteConfig } from "../types.ts"
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

function renderRuntimeModule(file: string, runtimeConfig: ResolvedDBViteConfig) {
  const imports = runtimeConfig.definitions.flatMap((definition, index) => [
    `import definition_${index} from ${JSON.stringify(createImportPath(file, definition.handler))}`,
    `import schema_${index} from ${JSON.stringify(createImportPath(file, runtimeConfig.generatedSchemaFilesByDatabase[definition.name]!))}`,
  ])
  const databaseEntries = runtimeConfig.databaseNames.map((name, index) => [
    `  [${JSON.stringify(name)}]: {`,
    runtimeConfig.databases[name]?.dialect === "postgresql"
      ? `    db: ${renderPostgresDatabaseExpression(name, runtimeConfig, `definition_${index}`)},`
      : `    db: createHostedDrizzleDb(${renderDatabaseConfigExpression(name, runtimeConfig, `definition_${index}`)}, schema_${index}),`,
    `    schema: schema_${index},`,
    "  },",
  ].join("\n"))

  return renderDatabaseRuntimeModule({
    createAgentDatabaseImport: createImportPath(file, resolveRuntimeModule("runtime/agent")),
    databaseEntries,
    imports: [
      ...(usesSqlite(runtimeConfig) ? [`import { createHostedDrizzleDb, resolveRuntimeCloudflareConfig } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule(usesD1HttpOnly(runtimeConfig) ? "runtime/d1" : "runtime/hosted")))}`] : []),
      ...(usesPostgres(runtimeConfig) ? [`import { createPostgresDatabase } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/postgres")))}`] : []),
      "",
      ...imports,
    ],
  })
}

/** Writes hosted modules before a framework resolves its generated runtime aliases. */
export async function writeHostedDatabaseRuntimeModules(
  generatedDir: string,
  runtimeConfig: ResolvedDBViteConfig,
  providers: readonly DBProvider[] = ["cloudflare", "vercel"],
) {
  const unprojectedNativeDatabases = runtimeConfig.databaseNames.filter((name) => {
    const database = runtimeConfig.databases[name]
    if (database?.dialect === "postgresql") return false
    const projection = runtimeConfig.definitionDefaults.cloudflareProjections?.[name]
    const cloudflare = database?.cloudflare ?? runtimeConfig.definitionDefaults.cloudflare
    return (projection?.resource === "opaque" || (projection?.resource === "configured" && !projection.binding))
      && cloudflare && !cloudflare.http && !isRemoteLibsqlConnectionUrl(database?.connection?.url)
  })
  if (providers.includes("cloudflare") && unprojectedNativeDatabases.length) {
    const opaqueNativeDatabases = unprojectedNativeDatabases.filter(name => runtimeConfig.definitionDefaults.cloudflareProjections[name]?.resource === "opaque")
    if (opaqueNativeDatabases.length) {
      throw databaseErrorDiagnostics.DATABASE_OPAQUE_CLOUDFLARE_CONFIG({ databases: opaqueNativeDatabases })
    }
    throw databaseErrorDiagnostics.DATABASE_MISSING_D1_RESOURCE({ databases: unprojectedNativeDatabases, missing: "resolved `cloudflare.databaseId` and `cloudflare.databaseName` values" })
  }
  if (providers.includes("cloudflare")) resolveCloudflareD1Bindings(runtimeConfig)
  const definitionDefaults = normalizeDefinitionDefaults(runtimeConfig.definitionDefaults)
  const normalizedRuntimeConfig = { ...runtimeConfig, definitionDefaults }
  const definitionDefaultsFile = resolve(generatedDir, "definition-defaults.mjs")
  await mkdir(generatedDir, { recursive: true })
  await Promise.all([
    writeFile(definitionDefaultsFile, `export default ${serializeGeneratedRegistry(definitionDefaults)}\n`, "utf8"),
    ...providers.map(async (provider) => {
      const file = resolve(generatedDir, `${provider}-runtime.mjs`)
      await writeFile(file, renderRuntimeModule(file, normalizedRuntimeConfig), "utf8")
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
    if (runtimeConfig.databases[name]?.dialect === "postgresql") return false
    const cloudflare = runtimeConfig.databases[name]?.cloudflare
    return hasConfigValue(resolveDatabaseId(runtimeConfig, name, provisionState))
      && !hasConfigValue(resolveConfigValue(cloudflare?.databaseName))
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

/** Reports whether the hosted runtime module can serve every configured database on the provider. */
export function supportsHostedDatabaseRuntime(provider: DBProvider, runtimeConfig: ResolvedDBViteConfig, provisionState: ProvisionState) {
  return provider === "cloudflare"
    ? getCloudflareUnsupportedDatabases(runtimeConfig, provisionState).length === 0
      && getCloudflareDatabasesMissingNames(runtimeConfig, provisionState).length === 0
    : getVercelUnsupportedDatabases(runtimeConfig).length === 0
}
