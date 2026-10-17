import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { getViteMode } from "@vite-hub/internal/build/mode"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { contributeProviderDeploymentOutput, createDefaultCloudflareOutputRoot, createDefaultVercelOutputRoot, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, resetProviderOutputRuntime, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { removeProviderOutputArtifactDir, retainProviderOutputSources } from "@vite-hub/internal/build/provider-output-sources"
import { createNoExternalAddition, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { normalize } from "pathe"
import { computePackageDir, resolveRuntimeModule } from "@vite-hub/internal/build/paths"

import { createDbCliContributor } from "./cli.ts"
import { collectDatabaseContributions } from "./contributions.ts"
import { cloudflareOptions, mergeCloudflareD1Bindings, mergeCloudflareHyperdriveBindings, resolveCloudflareD1Bindings, resolveCloudflareHyperdriveBindings } from "./internal/cloudflare.ts"
import { resolveDBViteConfig, serializeGeneratedRegistry } from "./config.ts"
import { removeGeneratedDatabaseTypes, writeGeneratedDatabaseArtifacts } from "./internal/generated.ts"
import { renderDatabaseConfigExpression, renderPostgresDatabaseExpression, usesPostgres, usesSqlite } from "./internal/runtime-config-expression.ts"
import { dbPackageName, generateProviderOutputs, prepareProviderOutputs, shouldCreateCloudflareOutput, shouldCreateVercelOutput } from "./internal/vite-build.ts"
import { readProvisionStateSync } from "@vite-hub/internal/provision-state"
import { inspectDatabaseDefinitions } from "./inspect.ts"
import { createDatabaseProvisionStep } from "./provision.ts"
import { resolveSourceImport } from "./internal/source-dependencies.ts"

import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ViteHubInspectionContributor } from "@vite-hub/internal/inspect"
import type { ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { ModuleNode, Plugin, ResolvedConfig, ViteDevServer } from "vite"
import type { CollectedDatabaseContribution, DatabaseContributingPlugin } from "./contributions.ts"
import type { DatabaseTableNameOptions } from "./internal/schema-tables.ts"
import type { DBModulePublicOptions, NuxtDatabaseViteOptions, ResolvedDBViteConfig } from "./types.ts"

export const DB_VIRTUAL_SCHEMA_ID = "#vitehub/database/schema"
export const DB_VIRTUAL_DATABASES_ID = "#vitehub/database/databases"
const DB_VIRTUAL_DEFINITION_DEFAULTS_ID = "#vitehub/database/definition-defaults"
export const DB_VITE_PLUGIN_NAME = "@vite-hub/database/vite"
export { inspectDatabaseDefinitions, type DatabaseInspectionOptions } from "./inspect.ts"
export { collectDatabaseContributions, describeDatabaseContribution, resolveDatabaseContributionTargets, resolveDefaultDatabase } from "./contributions.ts"
export type {
  CollectedDatabaseContribution,
  DatabaseContributingPlugin,
  DatabaseContribution,
  DatabaseContributionContext,
  DatabaseContributionFactory,
  DatabaseContributionFields,
  DefaultDatabaseResolution,
  ResolvedDatabaseContribution,
} from "./contributions.ts"

const DB_INTERNAL_VIRTUAL_SCHEMA_ID = "virtual:vitehub/database/schema"
const DB_INTERNAL_VIRTUAL_DATABASES_ID = "virtual:vitehub/database/databases"
const RESOLVED_DB_VIRTUAL_SCHEMA_ID = `\0${DB_VIRTUAL_SCHEMA_ID}`
const RESOLVED_DB_VIRTUAL_DATABASES_ID = `\0${DB_VIRTUAL_DATABASES_ID}`
const RESOLVED_DB_VIRTUAL_DEFINITION_DEFAULTS_ID = `\0${DB_VIRTUAL_DEFINITION_DEFAULTS_ID}`
const NITRO_MIGRATIONS_DIR = ".vitehub/database/migrations"
const NITRO_REQUEST_SCOPE_MIDDLEWARE = ".vitehub/nitro/database/request-scope.mjs"
const DB_DRIZZLE_ENTRY_PATTERN = /(?:^|\/)(?:@vite-hub\/database|database)\/dist\/drizzle\.js$/

export interface DBVitePluginAPI {
  getConfig: () => ResolvedDBViteConfig | undefined
  isEnabled: () => boolean
  refresh: () => Promise<ResolvedDBViteConfig | undefined>
}

interface DBCliContributingPlugin {
  vitehub?: NonNullable<DatabaseContributingPlugin["vitehub"]> & {
    cli?: () => Promise<ViteHubCliContributor | undefined>
    inspect?: () => ViteHubInspectionContributor | undefined
  }
}

/** The Nitro surface that the database plugin reads and extends on a Cloudflare host. */
interface DatabaseNitroHost {
  hooks: { hook: (name: "compiled", callback: () => Promise<void>) => void }
  options: {
    cloudflare?: { wrangler?: { d1_databases?: unknown, hyperdrive?: unknown } }
    handlers?: Array<{ handler: string, middleware?: boolean, route?: string }>
    output: { serverDir: string }
    preset?: string
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
  if (id === DB_VIRTUAL_DEFINITION_DEFAULTS_ID) return RESOLVED_DB_VIRTUAL_DEFINITION_DEFAULTS_ID
}

function rewriteDrizzleVirtualImports(code: string) {
  return code
    .replaceAll(DB_VIRTUAL_SCHEMA_ID, DB_INTERNAL_VIRTUAL_SCHEMA_ID)
    .replaceAll(DB_VIRTUAL_DATABASES_ID, DB_INTERNAL_VIRTUAL_DATABASES_ID)
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

function renderDatabasesModule(config: ResolvedDBViteConfig | undefined) {
  if (!config?.databaseNames.length) {
    return "export const databases = {}\nexport default databases\n"
  }

  const imports = config.definitions.map((definition, index) => [
    `import definition_${index} from ${JSON.stringify(definition.handler)}`,
    `import schema_${index} from ${JSON.stringify(config.generatedSchemaFilesByDatabase[definition.name])}`,
  ].join("\n"))
  const entries = config.definitions.map((definition, index) => [
    `  [${JSON.stringify(definition.name)}]: {`,
    config.databases[definition.name]?.dialect === "postgresql"
      ? `    db: ${renderPostgresDatabaseExpression(definition.name, config, `definition_${index}`)},`
      : `    config: ${renderDatabaseConfigExpression(definition.name, config, `definition_${index}`)},`,
    `    schema: schema_${index},`,
    "  },",
  ].join("\n"))

  return [
    // A Postgres-only app must not bundle the libSQL client that `runtime/hosted` imports.
    ...(usesSqlite(config) ? [`import { resolveRuntimeCloudflareConfig } from ${JSON.stringify(resolveRuntimeModule(computePackageDir(import.meta.url), "runtime/hosted"))}`] : []),
    ...(usesPostgres(config) ? [`import { createPostgresDatabase } from ${JSON.stringify(resolveRuntimeModule(computePackageDir(import.meta.url), "runtime/postgres"))}`] : []),
    ...imports,
    "",
    "export const databases = {",
    ...entries,
    "}",
    "export default databases",
    "",
  ].join("\n")
}

function renderNitroRequestScopeMiddleware() {
  return [
    `import { runWithActiveCloudflareEnv, setActiveCloudflareEnv } from ${JSON.stringify(resolveRuntimeModule(computePackageDir(import.meta.url), "runtime/state"))}`,
    "",
    "export default (event, next) => {",
    "  const env = event?.env ?? event?.req?.runtime?.cloudflare?.env ?? event?.context?.cloudflare?.env ?? event?.context?._platform?.cloudflare?.env ?? globalThis.__env__",
    "  if (typeof next === 'function') return runWithActiveCloudflareEnv(env, next)",
    "  setActiveCloudflareEnv(env)",
    "}",
    "",
  ].join("\n")
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

export function hubDb(options?: DBModulePublicOptions): DBVitePlugin {
  let nitroOptions: DatabaseNitroHost["options"] | undefined
  let nitroMigrations: Array<{ source: string, target: string }> = []
  let providerOutput: ProviderOutputCatalog | undefined
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  let resolved: ResolvedConfig | undefined
  let runtimeConfig: ResolvedDBViteConfig | undefined
  let serverDirs: string[] | undefined
  let contributions: CollectedDatabaseContribution[] = []
  let contributionFiles = new Set<string>()
  let contributionDependencyFiles = new Set<string>()
  let contributionDirectories = new Set<string>()

  function resolvedOptions() {
    return resolved?.database ?? options
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
    }
  }

  // `vitehub db generate` passes `strict` so a Definition that cannot load fails instead of dropping tables.
  async function refreshRuntimeConfig(options: { strict?: boolean } = {}) {
    if (!resolved) return
    runtimeConfig = resolveDBViteConfig(resolvedOptions(), databaseRoot(), {
      contributions,
      implicitDefault: true,
      provisionRoot: resolved.root,
      serverDirs: databaseServerDirs(),
    })
    if (runtimeConfig) {
      await writeGeneratedDatabaseArtifacts(runtimeConfig, tableNameOptions(options.strict))
    } else {
      await removeGeneratedDatabaseTypes(databaseRoot())
    }
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
    if (!nitroOptions || !runtimeConfig || !usesPostgres(runtimeConfig) || getHostingProvider(nitroOptions.preset) !== "cloudflare") return
    const handler = resolve(databaseRoot(), NITRO_REQUEST_SCOPE_MIDDLEWARE)
    mkdirSync(dirname(handler), { recursive: true })
    writeFileSync(handler, renderNitroRequestScopeMiddleware())
    const handlers = nitroOptions.handlers ??= []
    if (!handlers.some(item => item.handler === handler)) handlers.unshift({ handler, middleware: true })
  }

  async function copyNitroMigrations(serverDir: string) {
    if (!nitroMigrations.length) return
    await rm(resolve(serverDir, NITRO_MIGRATIONS_DIR), { force: true, recursive: true })
    await Promise.all(nitroMigrations.map(async ({ source, target }) => {
      const outputDir = resolve(serverDir, target)
      const entries = await readdir(source, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      })
      await mkdir(outputDir, { recursive: true })
      await Promise.all(entries
        .filter(entry => entry.isFile() && entry.name.endsWith(".sql"))
        .map(entry => copyFile(resolve(source, entry.name), resolve(outputDir, entry.name))))
    }))
  }

  return {
    name: DB_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      getConfig: () => runtimeConfig,
      isEnabled: () => resolvedOptions() !== false,
      refresh: () => refreshRuntimeConfig(),
    },
    nitro: {
      name: "@vite-hub/database/cloudflare-bindings",
      setup(nitro) {
        nitroOptions = nitro.options
        mergeNitroCloudflareD1Bindings()
        installNitroPostgresRequestScope()
        nitro.hooks.hook("compiled", () => copyNitroMigrations(nitro.options.output.serverDir))
      },
    },
    vitehub: {
      cli: async () => {
        const db = resolvedOptions()
        if (db === false) return
        const contributor = createDbCliContributor(db?.cli, refreshRuntimeConfig)
        const provision = [createDatabaseProvisionStep(databaseRoot, db)]
        return contributor ? { ...contributor, provision } : { namespaces: [], provision }
      },
      inspect: () => {
        if (resolvedOptions() === false) return
        const runtime = runtimeConfig
        const rootDir = resolved?.root ?? process.cwd()
        const provisionState = readProvisionStateSync(rootDir)
        return {
          definitions: [{
            kind: "database",
            label: "Databases",
            list: () => inspectDatabaseDefinitions({
              implicitDefault: true,
              plugins: resolved?.plugins,
              projectRoot: resolveViteHubProjectRoot(resolved?.root ?? process.cwd()),
              rootDir: databaseRoot(),
              serverDirs: databaseServerDirs(),
              viteRoot: resolved?.root,
            }),
          }],
          providerOutput: runtime ? [
            ...(shouldCreateCloudflareOutput(runtime, provisionState) ? [{ description: "Generated Cloudflare Database worker", owner: "database", path: resolve(createDefaultCloudflareOutputRoot(rootDir), "index.js") }] : []),
            ...(shouldCreateVercelOutput(runtime) ? [{ description: "Generated Vercel Database function", owner: "database", path: resolve(createDefaultVercelOutputRoot(rootDir), "functions", resolveNitroVercelFunctionName(resolved ?? {}, "database") ?? "__server.func", "index.mjs") }] : []),
          ] : [],
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
        ? []
        : await collectDatabaseContributions(config.plugins, { projectRoot: resolveViteHubProjectRoot(config.root), root: config.root, serverDirs: databaseServerDirs() })
      const require = createRequire(pathToFileURL(resolve(databaseRoot(), "package.json")))
      contributionFiles = new Set(contributions.flatMap(contribution => {
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
      await refreshRuntimeConfig()
      mergeNitroCloudflareD1Bindings()
      installNitroPostgresRequestScope()
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
      providerOutputGenerations.capture(this, providerOutput)
      resetProviderOutputRuntime(providerOutput)
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
        RESOLVED_DB_VIRTUAL_DEFINITION_DEFAULTS_ID,
        ...Object.values(runtimeConfig?.generatedSchemaFilesByDatabase ?? {}),
      ]) {
        const module = context.server.moduleGraph.getModuleById(id)
        if (module) context.server.moduleGraph.invalidateModule(module)
      }
    },
    async buildEnd(error) {
      if (error) {
        await providerOutputGenerations.reset(this, providerOutput, error)
        return
      }
      if (!resolved || !runtimeConfig || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }

      let artifactDir: string | undefined
      try {
        const contributionResolved = resolved
        const contributionRuntimeConfig = runtimeConfig
        const contributionProviderOutput = providerOutput
        const generation = providerOutputGenerations.get(this)
        await writeGeneratedDatabaseArtifacts(contributionRuntimeConfig, tableNameOptions())
        artifactDir = resolve(contributionResolved.root, ".vitehub/database-generations", randomUUID())
        const contributionArtifactDir = artifactDir
        const retainedSources = await retainProviderOutputSources({
          artifactDir: resolve(contributionArtifactDir, "sources"),
          paths: [
            ...contributionRuntimeConfig.definitions.flatMap(definition => [definition.handler, ...definition.schemaSources.map(source => source.handler)]),
            ...Object.values(contributionRuntimeConfig.generatedSchemaFilesByDatabase),
          ],
          roots: [contributionResolved.root],
        })
        const retainedRuntimeConfig = {
          ...contributionRuntimeConfig,
          definitions: contributionRuntimeConfig.definitions.map(definition => ({
            ...definition,
            handler: retainedSources.resolve(definition.handler),
            schemaSources: definition.schemaSources.map(source => ({ ...source, handler: retainedSources.resolve(source.handler) })),
          })),
          generatedSchemaFilesByDatabase: Object.fromEntries(Object.entries(contributionRuntimeConfig.generatedSchemaFilesByDatabase)
            .map(([name, file]) => [name, retainedSources.resolve(file)])),
        }
        const contributionArtifacts = await prepareProviderOutputs({
          appRootDir: retainedSources.resolve(contributionResolved.root),
          artifactDir: resolve(contributionArtifactDir, "output"),
          generation,
          providerOutput: contributionProviderOutput,
          rootDir: databaseRoot(),
          runtimeConfig: retainedRuntimeConfig,
        })
        contributeProviderDeploymentOutput(contributionProviderOutput, {
          discard: async () => await removeProviderOutputArtifactDir(contributionArtifactDir),
          owner: "database",
          rootDir: contributionResolved.root,
          write: async ({ write }) => {
            await generateProviderOutputs({
              appRootDir: retainedSources.resolve(contributionResolved.root),
              artifacts: contributionArtifacts,
              clientOutDir: contributionResolved.build.outDir,
              generation,
              providerOutput: contributionProviderOutput,
              rootDir: contributionResolved.root,
              runtimeConfig: retainedRuntimeConfig,
              serverFunctionName: resolveNitroVercelFunctionName(contributionResolved, "database"),
            }, write)
          },
        }, generation)
      }
      catch (error) {
        if (artifactDir) await removeProviderOutputArtifactDir(artifactDir)
        await providerOutputGenerations.reset(this, providerOutput, error)
        throw error
      }
    },
    resolveId(id) {
      return resolveDatabaseVirtualId(id)
    },
    transform(code, id) {
      if (DB_DRIZZLE_ENTRY_PATTERN.test(normalize(id))) return rewriteDrizzleVirtualImports(code)
    },
    load(id) {
      if (id === RESOLVED_DB_VIRTUAL_SCHEMA_ID) return renderSchemaModule(runtimeConfig)
      if (id === RESOLVED_DB_VIRTUAL_DATABASES_ID) return renderDatabasesModule(runtimeConfig)
      if (id === RESOLVED_DB_VIRTUAL_DEFINITION_DEFAULTS_ID) {
        const options = resolvedOptions()
        return `export default ${serializeGeneratedRegistry(runtimeConfig?.definitionDefaults ?? {
          ...(options && options.driver === "d1" ? { cloudflare: cloudflareOptions(options) ?? {} } : {}),
          ...(options && options.connection ? { connection: options.connection } : {}),
        })}\n`
      }
    },
    async renderError(error) {
      await providerOutputGenerations.reset(this, providerOutput, error)
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        if (!resolved || !runtimeConfig || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
        await finalizeProviderDeploymentOutputs(providerOutput)
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    database?: DBModulePublicOptions
  }
}
