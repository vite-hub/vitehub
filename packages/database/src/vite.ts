import { readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { durabilityModuleFile } from "@vite-hub/internal/durability"
import { databaseDurabilityUrl } from "./durability.ts"
import { writeFileIfChangedSync } from "@vite-hub/internal/definition-catalog"
import { getHostingProvider, resolveHost, resolveHostPreset } from "@vite-hub/internal/hosting"
import { contributeProviderRuntime, createProviderDeploymentOutputGenerationState, resetProviderOutputRuntime, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalAddition, getDeploymentPreset, getResolvedFeatureOptions, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { normalize } from "pathe"
import { computePackageDir, resolveRuntimeModule } from "@vite-hub/internal/build/paths"
import { wasmSqliteTraceDeps } from "@vite-hub/internal/runtime/sqlite-wasm"
import { isWebContainer } from "@vite-hub/web-container/env"

import { createDbCliContributor } from "./cli.ts"
import { databaseErrorDiagnostics } from "./error-diagnostics.ts"
import { collectDatabaseContributions } from "./contributions.ts"
import { cloudflareOptions, mergeCloudflareD1Bindings, mergeCloudflareHyperdriveBindings, resolveCloudflareD1Bindings, resolveCloudflareHyperdriveBindings } from "./internal/cloudflare.ts"
import { collapseGeneratedWranglerD1Bindings } from "./internal/wrangler-output.ts"
import { copyD1MigrationFiles } from "./internal/d1-migrations.ts"
import { libsqlStartupRule } from "./internal/bundle-startup.ts"
import { resolveDBViteConfig, serializeGeneratedRegistry } from "./config.ts"
import { removeGeneratedDatabaseTypes, writeGeneratedDatabaseArtifacts } from "./internal/generated.ts"
import { pgliteDatabases, renderDatabaseConfigExpression, renderPostgresDatabaseExpression, usesD1ReadReplication, usesPostgres, usesSqlite } from "./internal/runtime-config-expression.ts"
import { assertDefinitionD1Resources, assertHostedDatabaseRuntimeResources, dbPackageName, supportsHostedDatabaseRuntime, usesRemoteLibsql, writeHostedDatabaseRuntimeModules } from "./internal/vite-build.ts"
import { migrateOnStartPluginFile, renderMigrateOnStartPlugin, renderShippedMigrationsModule, resolveMigrateOnStart, selectMigrateOnStartDatabases } from "./internal/migrate-on-start.ts"
import { readProvisionStateSync } from "@vite-hub/internal/provision-state"
import { inspectDatabaseDefinitions, inspectDatabaseResources } from "./inspect.ts"
import { createDatabaseProvisionStep } from "./provision.ts"
import { resolveSourceImport } from "./internal/source-dependencies.ts"

import type { DurabilityPluginMetadata } from "@vite-hub/internal/durability"
import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ViteHubInspectionContributor } from "@vite-hub/internal/inspect"
import type { ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { DBProvider } from "./internal/vite-build.ts"
import type { DatabaseBundleStartupRule } from "./internal/bundle-startup.ts"
import type { ModuleNode, Plugin, ResolvedConfig, ViteDevServer } from "vite"
import type { CollectedDatabaseContributions, DatabaseContributingPlugin } from "./contributions.ts"
import type { DatabaseTableNameOptions } from "./internal/schema-tables.ts"
import type { DatabaseOptions, NuxtDatabaseViteOptions, ResolvedDBViteConfig } from "./types.ts"

export const DB_VIRTUAL_SCHEMA_ID = "#vitehub/database/schema"
export const DB_VIRTUAL_DATABASES_ID = "#vitehub/database/databases"
const DB_VIRTUAL_MIGRATIONS_ID = "#vitehub/database/migrations"
const DB_VIRTUAL_DEFINITION_DEFAULTS_ID = "#vitehub/database/definition-defaults"
const DB_LIBSQL_IMPORT = "#vitehub/database/libsql"
export const DB_VITE_PLUGIN_NAME = "@vite-hub/database/vite"
export { inspectDatabaseDefinitions, type DatabaseInspectionOptions } from "./inspect.ts"
export { collectDatabaseContributions, describeDatabaseContribution, resolveDatabaseContributionTargets, resolveDefaultDatabase } from "./contributions.ts"
export type {
  CollectedDatabaseContribution,
  CollectedDatabaseContributions,
  CollectedDatabaseDefinitionContribution,
  CollectedDatabaseUse,
  DatabaseContributingPlugin,
  DatabaseContribution,
  DatabaseContributionContext,
  DatabaseContributionEntry,
  DatabaseContributionFactory,
  DatabaseContributionFields,
  DatabaseDefinitionContribution,
  DatabaseUseContribution,
  DefaultDatabaseResolution,
  ResolvedDatabaseContribution,
  ResolvedDatabaseUse,
} from "./contributions.ts"

const DB_INTERNAL_VIRTUAL_SCHEMA_ID = "virtual:vitehub/database/schema"
const DB_INTERNAL_VIRTUAL_DATABASES_ID = "virtual:vitehub/database/databases"
const DB_INTERNAL_VIRTUAL_MIGRATIONS_ID = "virtual:vitehub/database/migrations"
const RESOLVED_DB_VIRTUAL_SCHEMA_ID = `\0${DB_VIRTUAL_SCHEMA_ID}`
const RESOLVED_DB_VIRTUAL_DATABASES_ID = `\0${DB_VIRTUAL_DATABASES_ID}`
const RESOLVED_DB_VIRTUAL_MIGRATIONS_ID = `\0${DB_VIRTUAL_MIGRATIONS_ID}`
const RESOLVED_DB_VIRTUAL_DEFINITION_DEFAULTS_ID = `\0${DB_VIRTUAL_DEFINITION_DEFAULTS_ID}`
const NITRO_MIGRATIONS_DIR = ".vitehub/database/migrations"
const NITRO_REQUEST_SCOPE_MIDDLEWARE = ".vitehub/nitro/database/request-scope.mjs"
const NITRO_REQUEST_STATS_MIDDLEWARE = ".vitehub/nitro/database/request-stats.mjs"
const HOSTED_RUNTIME_DIR = ".vitehub/database"
const DB_DRIZZLE_ENTRY_PATTERN = /(?:^|\/)(?:@vite-hub\/database|database)\/dist\/drizzle\.js$/

export interface DBVitePluginAPI {
  getConfig: () => ResolvedDBViteConfig | undefined
  /** Root that Database Definitions are discovered from, after `database.projectRoot`. */
  getProjectRoot: () => string
  isEnabled: () => boolean
  refresh: () => Promise<ResolvedDBViteConfig | undefined>
}

interface DBCliContributingPlugin {
  vitehub?: NonNullable<DatabaseContributingPlugin["vitehub"]> & DurabilityPluginMetadata & {
    cli?: () => Promise<ViteHubCliContributor | undefined>
    inspect?: () => ViteHubInspectionContributor | undefined
  }
}

/** The Nitro surface that the database plugin reads and extends on a Cloudflare host. */
interface DatabaseNitroHooks {
  hook(name: "compiled", callback: () => Promise<void>): void
  /** `@vite-hub/bundle` calls it when it writes the report of the server build. */
  hook(name: "vitehub:bundle:rules", callback: (rules: DatabaseBundleStartupRule[]) => void): void
}

interface DatabaseNitroHost {
  hooks: DatabaseNitroHooks
  options: {
    cloudflare?: { wrangler?: { d1_databases?: unknown, hyperdrive?: unknown, compatibility_flags?: unknown } }
    dev?: boolean
    handlers?: Array<{ handler: string, middleware?: boolean, route?: string }>
    output: { serverDir: string }
    plugins?: string[]
    preset?: string
    traceDeps?: (string | RegExp)[]
  }
}

export type DBVitePlugin = Plugin & DBCliContributingPlugin & {
  api: DBVitePluginAPI
  nitro: { name: string, setup: (nitro: DatabaseNitroHost) => void }
}

const mergeNoExternal = createNoExternalAddition(dbPackageName)

function viteStringAliases(alias: ResolvedConfig["resolve"]["alias"] | undefined): Record<string, string> {
  return Object.fromEntries((alias ?? []).flatMap(entry => String(entry.find) === entry.find ? [[String(entry.find), entry.replacement]] : []))
}

function resolveDatabaseVirtualId(id: string) {
  if (id === DB_VIRTUAL_SCHEMA_ID || id === DB_INTERNAL_VIRTUAL_SCHEMA_ID) return RESOLVED_DB_VIRTUAL_SCHEMA_ID
  if (id === DB_VIRTUAL_DATABASES_ID || id === DB_INTERNAL_VIRTUAL_DATABASES_ID) return RESOLVED_DB_VIRTUAL_DATABASES_ID
  if (id === DB_VIRTUAL_MIGRATIONS_ID || id === DB_INTERNAL_VIRTUAL_MIGRATIONS_ID) return RESOLVED_DB_VIRTUAL_MIGRATIONS_ID
  if (id === DB_VIRTUAL_DEFINITION_DEFAULTS_ID) return RESOLVED_DB_VIRTUAL_DEFINITION_DEFAULTS_ID
}

function rewriteDrizzleVirtualImports(code: string) {
  return code
    .replaceAll(DB_VIRTUAL_SCHEMA_ID, DB_INTERNAL_VIRTUAL_SCHEMA_ID)
    .replaceAll(DB_VIRTUAL_DATABASES_ID, DB_INTERNAL_VIRTUAL_DATABASES_ID)
    .replaceAll(DB_VIRTUAL_MIGRATIONS_ID, DB_INTERNAL_VIRTUAL_MIGRATIONS_ID)
}

function renderSchemaModule(config: ResolvedDBViteConfig | undefined) {
  if (!config?.databaseNames.length) {
    return "const schema = {}\nexport { schema }\nexport default schema\n"
  }
  const defaultName = config.databaseNames.includes("default") ? "default" : config.databaseNames[0]!
  return [
    `export * from ${JSON.stringify(config.generatedSchemaFilesByDatabase[defaultName])}`,
    `export { default, schema } from ${JSON.stringify(config.generatedSchemaFilesByDatabase[defaultName])}`,
    "",
  ].join("\n")
}

/** `dev` is true only for `vite dev`, where a Definition's `remote` switch applies. */
function renderDatabasesModule(config: ResolvedDBViteConfig | undefined, dev: boolean, localLimits?: "d1") {
  if (!config?.databaseNames.length) {
    return "export const databases = {}\nexport default databases\n"
  }

  const imports = config.definitions.map((definition, index) => [
    `import definition_${index} from ${JSON.stringify(definition.handler)}`,
    `import schema_${index}, { relations as relations_${index} } from ${JSON.stringify(config.generatedSchemaFilesByDatabase[definition.name])}`,
  ].join("\n"))
  const entries = config.definitions.map((definition, index) => [
    `  [${JSON.stringify(definition.name)}]: {`,
    config.databases[definition.name]?.dialect === "postgresql"
      ? `    db: ${renderPostgresDatabaseExpression(definition.name, config, `definition_${index}`, `schema_${index}`, `relations_${index}`, dev)},`
      : dev
        ? `    config: resolveDevRemoteConfig(${renderDatabaseConfigExpression(definition.name, config, `definition_${index}`, localLimits)}, definition_${index}.remote),`
        : `    config: ${renderDatabaseConfigExpression(definition.name, config, `definition_${index}`, localLimits)},`,
    `    relations: relations_${index},`,
    `    schema: schema_${index},`,
    "  },",
  ].join("\n"))

  return [
    // `runtime/d1` imports no libSQL client: `runtime/hosted` would add `@libsql/client/http`, which a local app does not use
    // and a WebContainer's `@libsql/client` does not export.
    ...(usesSqlite(config) ? [`import { ${dev ? "resolveDevRemoteConfig, " : ""}resolveRuntimeCloudflareConfig } from ${JSON.stringify(resolveRuntimeModule(computePackageDir(import.meta.url), "runtime/d1"))}`] : []),
    ...(usesPostgres(config)
      ? [dev
          ? `import { createDevPostgresDatabase } from ${JSON.stringify(resolveRuntimeModule(computePackageDir(import.meta.url), "runtime/pglite"))}`
          : `import { createPostgresDatabase } from ${JSON.stringify(resolveRuntimeModule(computePackageDir(import.meta.url), "runtime/postgres"))}`]
      : []),
    ...imports,
    "",
    "export const databases = {",
    ...entries,
    "}",
    "export default databases",
    "",
  ].join("\n")
}

/** Evaluate the same Definitions and precedence as the Database runtime, without opening a connection. */
function renderDatabaseDurabilityModule(config: ResolvedDBViteConfig, dev: boolean) {
  const safeConfig: ResolvedDBViteConfig = {
    ...config,
    databases: Object.fromEntries(Object.entries(config.databases).map(([name, database]) => [name, {
      ...database,
      connection: database.connection?.url === undefined ? undefined : { url: databaseDurabilityUrl(database.connection.url) },
    }])),
  }
  const entries = config.definitions.map((definition, index) => {
    const expression = renderDatabaseConfigExpression(definition.name, safeConfig, `definition_${index}`)
    return dev ? `resolveDevRemoteConfig(${expression}, definition_${index}.remote)` : expression
  })
  return [
    `import { databaseDurability as report } from ${JSON.stringify(durabilityModuleFile(import.meta.url))}`,
    `import { resolveDevRemoteConfig, resolveRuntimeCloudflareConfig } from ${JSON.stringify(resolveRuntimeModule(computePackageDir(import.meta.url), "runtime/d1"))}`,
    ...config.definitions.map((definition, index) => `import definition_${index} from ${JSON.stringify(definition.handler)}`),
    "export function databaseDurability(_input, context) {",
    `  const databases = [${entries.join(",\n")}].map(database => ({`,
    "    dialect: database.dialect, name: database.name, http: database.cloudflare?.http, url: database.connection?.url,",
    "  }))",
    "  return report({ databases }, context)",
    "}",
    "",
  ].join("\n")
}

function renderNitroRequestScopeMiddleware() {
  return [
    `import { getRequestCloudflareEnv, runWithActiveCloudflareEnv, runWithDatabaseRequest } from ${JSON.stringify(resolveRuntimeModule(computePackageDir(import.meta.url), "runtime/state"))}`,
    "",
    "export default (event, next) => {",
    "  const env = getRequestCloudflareEnv(event) ?? globalThis.__env__",
    "  return runWithActiveCloudflareEnv(env, () => runWithDatabaseRequest(event, next))",
    "}",
    "",
  ].join("\n")
}

function renderNitroRequestStatsMiddleware() {
  return [
    `import { runWithDatabaseRequestStats } from ${JSON.stringify(resolveRuntimeModule(computePackageDir(import.meta.url), "runtime/request-stats"))}`,
    "",
    "export default (event, next) => runWithDatabaseRequestStats(event, next)",
    "",
  ].join("\n")
}

// Under `vitehub()`, the dev server config names the deployment preset, and Nitro has none.
function devServerTargetsCloudflare(config: ResolvedConfig | undefined): boolean {
  if (config?.command !== "serve") return false
  return resolveHost({ hosting: getDeploymentPreset(config), nitro: Reflect.get(config, "nitro") }) === "cloudflare"
}

function resolveHostedProvider(config: ResolvedConfig): DBProvider | undefined {
  const hosting = resolveHost({ nitro: Reflect.get(config, "nitro") })
  if (hosting === "cloudflare" || hosting === "vercel") return hosting
  return resolveNitroVercelFunctionName(config, "database") ? "vercel" : undefined
}

function normalizeModulePath(id: string) {
  return normalize(id.split("?", 1)[0]!)
}

function moduleGraphContainsFile(server: Pick<ViteDevServer, "moduleGraph">, entry: string, changedFile: string, affected: readonly ModuleNode[] = []) {
  const root = server.moduleGraph.getModuleById(entry)
  const pending: ModuleNode[] = root ? [root] : []
  const visited = new Set<ModuleNode>()
  while (pending.length) {
    const module = pending.pop()!
    if (visited.has(module)) continue
    visited.add(module)
    if (module.id && normalizeModulePath(module.id) === changedFile) return true
    pending.push(...module.importedModules)
  }
  // For an unloaded changed file, Vite may provide an affected importer node but
  // no module node for the file. Walk those nodes' importers to find the entry.
  const importerSearch: ModuleNode[] = [...affected]
  const importerVisited = new Set<ModuleNode>()
  while (importerSearch.length) {
    const module = importerSearch.pop()!
    if (importerVisited.has(module)) continue
    importerVisited.add(module)
    if (module.id && normalizeModulePath(module.id) === normalizeModulePath(entry)) return true
    importerSearch.push(...module.importers)
  }
  return false
}

async function collectSourceDependencies(file: string, require: NodeRequire, files: Set<string>, seen = new Set<string>()) {
  file = normalize(file)
  if (seen.has(file)) return
  seen.add(file)
  files.add(file)
  let source: string
  try { source = await readFile(file, "utf8") } catch { return }
  const imports = source.matchAll(/(?:from\s*["']|import\s*\(\s*["']|import\s*["']|export\s+[^;]*?from\s*["'])([^"']+)["']/g)
  for (const match of imports) {
    try {
      const resolved = resolveSourceImport(match[1]!, file, require)
      if (resolved) await collectSourceDependencies(normalize(resolved), require, files, seen)
    }
    catch { /* unresolved aliases are handled by the host module graph */ }
  }
}

export function hubDb(options?: DatabaseOptions): DBVitePlugin {
  let nitroOptions: DatabaseNitroHost["options"] | undefined
  let nitroMigrations: Array<{ source: string, target: string }> = []
  let providerOutput: ProviderOutputCatalog | undefined
  const siblingRuntimeGenerations = createProviderDeploymentOutputGenerationState()
  let resolved: ResolvedConfig | undefined
  let runtimeConfig: ResolvedDBViteConfig | undefined
  // `vite dev` writes the generated schemas in the background. The Database virtual modules wait for them.
  let generatedArtifacts: Promise<unknown> = Promise.resolve()
  let serverDirs: string[] | undefined
  let contributions: CollectedDatabaseContributions = { definitions: [], tables: [], uses: [] }
  let contributionFiles = new Set<string>()
  let contributionDependencyFiles = new Set<string>()
  let contributionDirectories = new Set<string>()

  function resolvedOptions() {
    return (resolved && getResolvedFeatureOptions<DatabaseOptions>(resolved, "database")) ?? options
  }

  function integrationReadReplication() {
    const database = resolvedOptions()
    return database && database.driver === "d1" ? database.readReplication : undefined
  }

  function databaseRoot() {
    const database = resolvedOptions()
    return resolve(resolved?.root ?? process.cwd(), database && "projectRoot" in database ? database.projectRoot ?? "." : ".")
  }

  function databaseServerDirs() {
    const database = resolvedOptions()
    // The Database Nuxt bridge pins `projectRoot` and forwards the server directories of the application and its layers.
    if (database && "nuxtServerDirs" in database) {
      // SAFETY: Only the Database Nuxt bridge sets `nuxtServerDirs`, and it always sets a string array.
      return (database as NuxtDatabaseViteOptions).nuxtServerDirs
    }
    return database && "projectRoot" in database && database.projectRoot !== undefined
      ? [resolve(databaseRoot(), "server")]
      : serverDirs
  }

  function tableNameOptions(strict = false): DatabaseTableNameOptions {
    const logger = resolved?.logger
    return {
      alias: viteStringAliases(resolved?.resolve?.alias),
      onFallback: strict ? undefined : message => logger ? logger.warn(message) : console.warn(message),
      worker: !strict && resolved?.command === "serve",
    }
  }

  async function waitForGeneratedArtifacts() {
    let generation: Promise<unknown>
    do {
      generation = generatedArtifacts
      await generation
      // A hot update may have queued another generation while this load was waiting.
    } while (generation !== generatedArtifacts)
  }

  // `vitehub database generate` passes `strict` so a Definition that cannot load fails instead of dropping tables.
  async function refreshRuntimeConfig(options: { strict?: boolean } = {}) {
    if (!resolved) return
    runtimeConfig = resolveDBViteConfig(resolvedOptions(), databaseRoot(), {
      contributions,
      implicitDefault: true,
      provisionRoot: resolved.root,
      serverDirs: databaseServerDirs(),
    })
    const config = runtimeConfig
    const root = databaseRoot()
    const schemaOptions = tableNameOptions(options.strict)
    // Keep all shared artifact writes in order, including removal when Database is disabled. A failed generation
    // still rejects its waiting imports, but must not prevent a later refresh from recovering.
    generatedArtifacts = generatedArtifacts.catch(() => {}).then(() => config
      ? writeGeneratedDatabaseArtifacts(config, schemaOptions)
      : removeGeneratedDatabaseTypes(root))
    await waitForGeneratedArtifacts()
    return runtimeConfig
  }

  // Nitro writes `wrangler.json` from its own options, so a Cloudflare Nitro build needs the D1 and Hyperdrive bindings there.
  // Wrangler resolves `migrations_dir` from that file, so migration SQL is copied beside it.
  function mergeNitroCloudflareD1Bindings() {
    if (!nitroOptions || !runtimeConfig || getHostingProvider(nitroOptions.preset) !== "cloudflare") return
    const hyperdrive = resolveCloudflareHyperdriveBindings(runtimeConfig)
    if (hyperdrive.length) {
      const wrangler = (nitroOptions.cloudflare ??= {}).wrangler ??= {}
      wrangler.hyperdrive = mergeCloudflareHyperdriveBindings(wrangler.hyperdrive, hyperdrive)
    }
    const { d1Databases } = resolveCloudflareD1Bindings(runtimeConfig, { provisionState: readProvisionStateSync(resolved?.root ?? process.cwd()) })
    if (!d1Databases.length) return
    const bindings = d1Databases.map(binding => binding.migrations_dir
      ? { ...binding, migrations_dir: `${NITRO_MIGRATIONS_DIR}/${binding.binding}` }
      : binding)
    nitroMigrations = d1Databases.flatMap(binding => binding.migrations_dir
      ? [{ source: resolve(databaseRoot(), binding.migrations_dir), target: `${NITRO_MIGRATIONS_DIR}/${binding.binding}` }]
      : [])
    const wrangler = (nitroOptions.cloudflare ??= {}).wrangler ??= {}
    wrangler.d1_databases = mergeCloudflareD1Bindings(wrangler.d1_databases, bindings)
  }

  // Workers reuse the env object across requests. This middleware gives each request its own scope,
  // so the Postgres runtime creates one client per request.
  function installNitroPostgresRequestScope() {
    if (!nitroOptions || !runtimeConfig || !(usesPostgres(runtimeConfig) || usesD1ReadReplication(runtimeConfig)) || getHostingProvider(nitroOptions.preset) !== "cloudflare") return
    const handler = resolve(databaseRoot(), NITRO_REQUEST_SCOPE_MIDDLEWARE)
    writeFileIfChangedSync(handler, renderNitroRequestScopeMiddleware())
    const handlers = nitroOptions.handlers ??= []
    if (!handlers.some(item => item.handler === handler)) handlers.unshift({ handler, middleware: true })
  }

  // Each request's database calls go on its evlog wide event (`database`), whatever the host.
  function installNitroRequestStats() {
    if (!nitroOptions || !runtimeConfig) return
    const handler = resolve(databaseRoot(), NITRO_REQUEST_STATS_MIDDLEWARE)
    if (getHostingProvider(nitroOptions.preset) === "cloudflare") {
      const wrangler = (nitroOptions.cloudflare ??= {}).wrangler ??= {}
      const flags = Array.isArray(wrangler.compatibility_flags) ? [...wrangler.compatibility_flags] : []
      if (!flags.includes("nodejs_als")) flags.push("nodejs_als")
      wrangler.compatibility_flags = flags
    }
    writeFileIfChangedSync(handler, renderNitroRequestStatsMiddleware())
    const handlers = nitroOptions.handlers ??= []
    if (!handlers.some(item => item.handler === handler)) handlers.unshift({ handler, middleware: true })
  }

  // `ensureMigrations()` applies these. A Cloudflare or Vercel build applies migrations from the deployment, so it ships none.
  function renderViteShippedMigrationsModule() {
    const provider = resolved?.command === "build" ? resolveHostedProvider(resolved) : undefined
    if (provider) return `export default ${JSON.stringify({ allowDataLoss: false, databases: {}, unsupported: `The build targets ${provider}.` })}\n`
    return renderShippedMigrationsModule(runtimeConfig, { allowDataLoss: resolveMigrateOnStart(resolvedOptions())?.allowDataLoss ?? false })
  }

  // A Node server build applies pending migrations before it handles requests. In Nuxt the Database module installs it.
  function installNitroMigrateOnStart() {
    const database = resolvedOptions()
    const settings = resolveMigrateOnStart(database)
    if (!nitroOptions || !runtimeConfig || !settings || nitroOptions.dev || nitroOptions.preset === "nitro-prerender" || (database && "nuxtHostResource" in database)) return
    const databases = selectMigrateOnStartDatabases(runtimeConfig, settings, resolveHost({ nitro: nitroOptions }) ?? resolveHostPreset({ nitro: nitroOptions }))
    const packageDir = computePackageDir(import.meta.url)
    const source = renderMigrateOnStartPlugin(runtimeConfig, {
      databases,
      drizzleImport: resolveRuntimeModule(packageDir, "drizzle"),
      migrationsImport: DB_INTERNAL_VIRTUAL_MIGRATIONS_ID,
      runtimeImport: resolveRuntimeModule(packageDir, "runtime/migrate-on-start"),
    })
    if (!source) return
    const plugin = resolve(databaseRoot(), migrateOnStartPluginFile)
    writeFileIfChangedSync(plugin, source)
    const plugins = nitroOptions.plugins ??= []
    if (!plugins.includes(plugin)) plugins.push(plugin)
  }

  // A Cloudflare build reaches each Database through D1, or through a remote libSQL URL. Without such a URL, the Worker
  // ships no libSQL client. Development and other hosts keep local SQLite.
  function bundlesLibsql() {
    if (resolved?.command !== "build" || resolveHostedProvider(resolved) !== "cloudflare") return true
    return runtimeConfig ? usesRemoteLibsql(runtimeConfig) : false
  }

  async function copyNitroMigrations(serverDir: string) {
    if (!nitroMigrations.length) return
    await rm(resolve(serverDir, NITRO_MIGRATIONS_DIR), { force: true, recursive: true })
    await Promise.all(nitroMigrations.map(({ source, target }) => copyD1MigrationFiles(source, resolve(serverDir, target))))
  }

  return {
    name: DB_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      getConfig: () => runtimeConfig,
      getProjectRoot: databaseRoot,
      isEnabled: () => resolvedOptions() !== false,
      refresh: () => refreshRuntimeConfig(),
    },
    nitro: {
      name: "@vite-hub/database/cloudflare-bindings",
      setup(nitro) {
        nitroOptions = nitro.options
        if (isWebContainer()) nitro.options.traceDeps = [...new Set([...nitro.options.traceDeps ?? [], ...wasmSqliteTraceDeps])]
        mergeNitroCloudflareD1Bindings()
        installNitroPostgresRequestScope()
        installNitroRequestStats()
        installNitroMigrateOnStart()
        // Keep the feature hook surface when Nitro augments Vite's Plugin type.
        const hooks: DatabaseNitroHooks = nitro.hooks
        hooks.hook("vitehub:bundle:rules", (rules) => {
          const rule = libsqlStartupRule(runtimeConfig, nitro.options.preset)
          if (rule) rules.push(rule)
        })
        hooks.hook("compiled", async () => {
          await copyNitroMigrations(nitro.options.output.serverDir)
          if (nitroOptions && getHostingProvider(nitroOptions.preset) === "cloudflare") await collapseGeneratedWranglerD1Bindings(nitro.options.output.serverDir)
        })
      },
    },
    vitehub: {
      durability: () => {
        if (!runtimeConfig) return []
        const module = resolve(databaseRoot(), ".vitehub/database/durability.mjs")
        writeFileIfChangedSync(module, renderDatabaseDurabilityModule(runtimeConfig, resolved?.command === "serve"))
        return [{ export: "databaseDurability", input: {}, module, primitive: "database" }]
      },
      cli: async () => {
        const db = resolvedOptions()
        if (db === false) return
        const contributor = createDbCliContributor(db?.cli, refreshRuntimeConfig)
        const provision = [createDatabaseProvisionStep(databaseRoot, db, () => ({ contributions, serverDirs: databaseServerDirs() }))]
        return contributor ? { ...contributor, provision } : { namespaces: [], provision }
      },
      inspect: () => {
        const database = resolvedOptions()
        if (database === false) return
        return {
          definitions: [{
            kind: "database",
            label: "Databases",
            list: () => inspectDatabaseDefinitions({
              http: !!cloudflareOptions(database)?.http,
              implicitDefault: true,
              plugins: resolved?.plugins,
              projectRoot: resolveViteHubProjectRoot(resolved?.root ?? process.cwd()),
              readReplication: integrationReadReplication(),
              rootDir: databaseRoot(),
              serverDirs: databaseServerDirs(),
              viteRoot: resolved?.root,
            }),
          }],
          resources: () => inspectDatabaseResources({
            contributions,
            options: resolvedOptions(),
            provisionRoot: resolved?.root ?? process.cwd(),
            rootDir: databaseRoot(),
            serverDirs: databaseServerDirs(),
          }),
        }
      },
    },
    config(config) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
    },
    async configResolved(config) {
      resolved = config
      providerOutput = useProviderOutputCatalog(config)
      contributions = resolvedOptions() === false
        ? { definitions: [], tables: [], uses: [] }
        : await collectDatabaseContributions(config.plugins, { projectRoot: resolveViteHubProjectRoot(config.root), root: config.root, rootDir: databaseRoot(), serverDirs: databaseServerDirs() })
      const require = createRequire(pathToFileURL(resolve(databaseRoot(), "package.json")))
      contributionFiles = new Set(contributions.tables.flatMap(contribution => {
        try {
          return [normalize(require.resolve(contribution.definition.module))]
        }
        catch {
          return []
        }
      }))
      contributionDependencyFiles = new Set()
      for (const file of contributionFiles) await collectSourceDependencies(file, require, contributionDependencyFiles)
      contributionDirectories = new Set()
      for (const file of contributionFiles) {
        // Keep the fallback directory check local to the contribution entry.
        // Transitive imports are covered by the module-graph traversal below;
        // walking broad ancestors (such as the project root) causes unrelated
        // edits to regenerate the database during development.
        contributionDirectories.add(dirname(file))
      }
      const refresh = refreshRuntimeConfig()
      // `vite dev` lists the tables of each Definition in a worker thread and starts meanwhile. The Database virtual
      // modules wait for the generated schemas. A failure shows now and again on that import.
      if (config.command === "serve") {
        refresh.catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          // SAFETY: Vite always sets `logger`. Tests that call this hook pass a partial config without it.
          const logger = config.logger as ResolvedConfig["logger"] | undefined
          if (logger) logger.error(message)
          else console.error(message)
        })
      }
      else await refresh
      mergeNitroCloudflareD1Bindings()
      installNitroPostgresRequestScope()
      installNitroRequestStats()
      installNitroMigrateOnStart()
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }

      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    buildStart() {
      const database = resolvedOptions()
      // Production output has no PGlite. Under Nuxt, the module checks this in `nitro:config`.
      if (resolved?.command === "build" && runtimeConfig && !(database && "nuxtHostResource" in database)) {
        const databases = pgliteDatabases(runtimeConfig)
        if (databases.length) throw databaseErrorDiagnostics.DATABASE_PGLITE_IN_BUILD({ databases })
      }
      // Fail before bundling: without a D1 resource, the server bundle falls back to the Node libSQL client. Under Nuxt,
      // the module checks this in `nitro:config`, where it can see an alias that the app sets.
      if (resolved && runtimeConfig && !(database && "nuxtHostResource" in database) && !shouldSkipViteProviderBuild(resolved.command) && resolveHostedProvider(resolved) === "cloudflare") {
        const { unresolved } = resolveCloudflareD1Bindings(runtimeConfig, { provisionState: readProvisionStateSync(resolved.root) })
        assertDefinitionD1Resources(runtimeConfig, contributions, unresolved.map(binding => binding.database))
      }
      resetProviderOutputRuntime(providerOutput)
      siblingRuntimeGenerations.capture(this, providerOutput)
    },
    async handleHotUpdate(context) {
      if (!runtimeConfig) return

      const changedFile = normalizeModulePath(context.file)
      // Definitions and contributed table modules can import the changed file.
      const isDatabaseUpdate = [...runtimeConfig.definitions.map(definition => definition.handler), ...contributionDependencyFiles].some(file =>
        normalizeModulePath(file) === changedFile
        || moduleGraphContainsFile(context.server, file, changedFile, context.modules),
      ) || [...contributionDirectories].some(directory => changedFile === directory || changedFile.startsWith(`${normalizeModulePath(directory)}/`))
      if (!isDatabaseUpdate) return

      await refreshRuntimeConfig()

      // Vite only soft-invalidates the importers of a changed file and keeps their old code.
      // The refresh rewrites the generated schemas, so they must load again from disk.
      for (const id of [
        RESOLVED_DB_VIRTUAL_SCHEMA_ID,
        RESOLVED_DB_VIRTUAL_DATABASES_ID,
        RESOLVED_DB_VIRTUAL_MIGRATIONS_ID,
        RESOLVED_DB_VIRTUAL_DEFINITION_DEFAULTS_ID,
        ...Object.values(runtimeConfig?.generatedSchemaFilesByDatabase ?? {}),
      ]) {
        const module = context.server.moduleGraph.getModuleById(id)
        if (module) context.server.moduleGraph.invalidateModule(module)
      }
    },
    // Queue and Workflow still bundle their own host functions. They alias `@vite-hub/database/drizzle`
    // to this hosted runtime module, so Database calls in those functions use the same Definitions.
    async buildEnd(error) {
      const resetRuntimeContribution = () => {
        providerOutput?.resetRuntimeContributions(siblingRuntimeGenerations.get(this), "database")
      }
      // Only a failed build resets the environment's generation: other plugins' Provider Output shares it.
      if (error) {
        resetRuntimeContribution()
        await siblingRuntimeGenerations.reset(this, providerOutput, error)
        return
      }
      if (!resolved || !runtimeConfig || shouldSkipViteProviderBuild(resolved.command)) {
        resetRuntimeContribution()
        return
      }
      const provider = resolveHostedProvider(resolved)
      if (!provider) {
        resetRuntimeContribution()
        return
      }
      const runtimeDir = resolve(databaseRoot(), HOSTED_RUNTIME_DIR)
      if (!supportsHostedDatabaseRuntime(provider, runtimeConfig, readProvisionStateSync(resolved.root))) {
        resetRuntimeContribution()
        await Promise.all([
          rm(resolve(runtimeDir, `${provider}-runtime.mjs`), { force: true }),
          rm(resolve(runtimeDir, "definition-defaults.mjs"), { force: true }),
        ])
        return
      }
      assertHostedDatabaseRuntimeResources(runtimeConfig, [provider])
      const definitionDefaults = await writeHostedDatabaseRuntimeModules(runtimeDir, runtimeConfig, [provider])
      const runtimeModule = resolve(runtimeDir, `${provider}-runtime.mjs`)
      contributeProviderRuntime(providerOutput, {
        owner: "database",
        runtimeModules: provider === "cloudflare"
          ? { cloudflare: runtimeModule, "cloudflare-definition-defaults": definitionDefaults }
          : { vercel: runtimeModule, "vercel-definition-defaults": definitionDefaults },
      }, siblingRuntimeGenerations.get(this))
    },
    resolveId: {
      filter: { id: /^(?:(?:#|virtual:)vitehub\/database\/(?:schema|databases|migrations)|#vitehub\/database\/(?:definition-defaults|libsql))$/ },
      handler(id) {
        if (id === DB_LIBSQL_IMPORT) return bundlesLibsql() ? undefined : resolveRuntimeModule(computePackageDir(import.meta.url), "runtime/libsql-disabled")
        return resolveDatabaseVirtualId(id)
      },
    },
    transform: {
      filter: { id: /(?:^|[\\/])(?:@vite-hub[\\/]database|database)[\\/]dist[\\/]drizzle\.js$/ },
      handler(code, id) {
        if (DB_DRIZZLE_ENTRY_PATTERN.test(normalize(id))) return rewriteDrizzleVirtualImports(code)
      },
    },
    load: {
      filter: { id: /^\0#vitehub\/database\/(?:schema|databases|migrations|definition-defaults)$/ },
      handler(id) {
        if (id === RESOLVED_DB_VIRTUAL_SCHEMA_ID) return waitForGeneratedArtifacts().then(() => renderSchemaModule(runtimeConfig))
        if (id === RESOLVED_DB_VIRTUAL_DATABASES_ID) return waitForGeneratedArtifacts().then(() => renderDatabasesModule(runtimeConfig, resolved?.command === "serve", devServerTargetsCloudflare(resolved) ? "d1" : undefined))
        if (id === RESOLVED_DB_VIRTUAL_MIGRATIONS_ID) return waitForGeneratedArtifacts().then(() => renderViteShippedMigrationsModule())
        if (id === RESOLVED_DB_VIRTUAL_DEFINITION_DEFAULTS_ID) {
          const options = resolvedOptions()
          return `export default ${serializeGeneratedRegistry({
            ...runtimeConfig?.definitionDefaults ?? {
              ...(options && options.driver === "d1" ? { cloudflare: cloudflareOptions(options) ?? {} } : {}),
              ...(options && options.connection ? { connection: options.connection } : {}),
            },
            ...(resolved?.command === "serve" ? { dev: true } : {}),
          })}\n`
        }
      },
    },
  }
}
