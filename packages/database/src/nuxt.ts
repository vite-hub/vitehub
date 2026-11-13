import { readFile, rm } from "node:fs/promises"
import { watch as watchFs, type FSWatcher } from "node:fs"
import { createRequire } from "node:module"
import { dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { getResolvedFeatureOptions, resolveNuxtServerDirs, resolveViteHubGeneratedRoot, resolveViteHubProjectRoot, setResolvedFeatureOptions, VITEHUB_GENERATED_ROOT, type NuxtServerDirOptions } from "@vite-hub/internal/build/vite"
import { resolveRuntimeModule } from "@vite-hub/internal/build/paths"
import { resolveHost, resolveHostPreset } from "@vite-hub/internal/hosting"
import { createNitroServerKit, mergeNitroExternal } from "@vite-hub/internal/nitro-kit"
import { isPlainObject as isRecord } from "@vite-hub/internal/object"
import { readProvisionStateSync } from "@vite-hub/internal/provision-state"

import { mergeCloudflareD1Bindings, mergeCloudflareHyperdriveBindings, resolveCloudflareD1Binding, resolveCloudflareD1BindingName, resolveCloudflareD1Bindings, resolveCloudflareHyperdriveBindings } from "./internal/cloudflare.ts"
import { collapseGeneratedWranglerD1Bindings } from "./internal/wrangler-output.ts"
import { copyD1MigrationFiles } from "./internal/d1-migrations.ts"
import { libsqlStartupRule } from "./internal/bundle-startup.ts"
import { getDatabaseNuxtProvisionStateKey } from "./provision.ts"
import { renderDatabaseRuntimeModule } from "./internal/runtime-module.ts"
import { pgliteDatabases, renderPostgresDatabaseExpression, usesPostgres } from "./internal/runtime-config-expression.ts"
import { generatedDatabaseTypesFile, removeGeneratedDatabaseTypes, renderContributionImport, renderContributionRelationsImport, renderMergedRelations, writeGeneratedDatabaseArtifacts } from "./internal/generated.ts"
import { resolveSourceImport } from "./internal/source-dependencies.ts"
import { assertDistinctLoadedSchemas, loadContributedDatabaseSchema, loadDefinitionSchemas, mergeLoadedSchemas } from "./internal/schema-tables.ts"
import { collectDatabaseContributions, describeDatabaseContribution } from "./contributions.ts"
import { assertDefinitionD1Resources, assertHostedDatabaseRuntimeResources, hasRemoteDefinitionRuntime, usesD1HttpOnly, usesRemoteLibsql, writeHostedDatabaseRuntimeModules } from "./internal/vite-build.ts"
import { migrateOnStartPluginFile, renderMigrateOnStartPlugin, renderShippedMigrationsModule, resolveMigrateOnStart, selectMigrateOnStartDatabases, type MigrateOnStartSettings } from "./internal/migrate-on-start.ts"
import { installMigrateOnDeploy, type MigrateOnDeployNitro } from "./internal/migrate-on-deploy.ts"
import { resolveConfigValue, withConfigValueFallback } from "./config-value.ts"
import { resolveDBViteConfig, serializeGeneratedRegistry } from "./config.ts"
import { hubDatabase as hubDatabaseVite } from "./vite.ts"
import { isAbsolute } from "pathe"

import type { CollectedDatabaseContribution, CollectedDatabaseContributions } from "./contributions.ts"
import type { DatabaseBundleStartupRule } from "./internal/bundle-startup.ts"
import type { DatabaseNuxtIntegrationOptions, DatabaseOptions, NuxtDatabaseViteOptions, ResolvedDBViteConfig } from "./types.ts"
import type { Plugin } from "vite"
import { databaseErrorDiagnostics } from "./error-diagnostics.ts"

type ResolvedDatabaseNuxtIntegrationOptions = Exclude<DatabaseNuxtIntegrationOptions, false>
const generatedNitroDatabaseMiddleware = ".vitehub/nitro/database/middleware.ts"
const generatedNitroRequestStatsMiddleware = ".vitehub/nitro/database/request-stats.ts"
const generatedNitroLocalDatabaseRuntime = "database/local-runtime.mjs"
const generatedNitroShippedMigrations = "database/migrations.mjs"
const generatedNitroMigrationsDir = ".vitehub/database/migrations"
const databaseDefinitionDefaultsImport = "#vitehub/database/definition-defaults"
const databaseRegistryImport = "@vite-hub/database/runtime/registry"
const databaseRuntimeDir = fileURLToPath(new URL("./runtime/", import.meta.url))
const databaseRegistryTypes = resolve(databaseRuntimeDir, "../../dist/runtime/registry.d.ts")

type NuxtModuleDependencies = Record<string, {
  defaults?: Record<string, unknown>
  optional?: boolean
  overrides?: Record<string, unknown>
  version?: string
}>

type DatabaseNuxtModule = {
  (
    inlineOptions: DatabaseNuxtIntegrationOptions | undefined,
    nuxt: unknown,
  ): Promise<void> | void
  getMeta: () => {
    configKey: string
    name: string
  }
  getModuleDependencies: (nuxt: unknown) => NuxtModuleDependencies
}

type NuxtLike = {
  hook?: {
    (name: "nitro:config", callback: (value: Record<string, unknown>) => Promise<void> | void): void
    (name: "prepare:types", callback: (context: NuxtPrepareTypesContext) => void): void
    (name: "builder:watch", callback: (event: string, path: string) => Promise<void> | void): void
    (name: "close", callback: () => Promise<void> | void): void
    (name: "prepare:types", callback: (options: { serverTsConfig?: Record<string, unknown> }) => Promise<void> | void): void
  }
  options: Record<string, unknown> & {
    alias?: Record<string, string>
    _layers?: NuxtServerDirOptions["_layers"]
    /** True for `nuxt prepare`, which loads Nuxt with `dev: false` and writes types without a build. */
    _prepare?: boolean
    buildDir?: string
    dev?: boolean
    modules?: unknown[]
    nitro?: Record<string, unknown>
    rootDir?: string
    serverDir?: string
    srcDir?: string
    vite?: Record<string, unknown> & { plugins?: unknown[], root?: string }
    watch?: Array<string | RegExp>
  }
}

type NuxtPrepareTypesConfig = {
  include?: string[]
}

type NuxtPrepareTypesContext = {
  references: { path: string }[]
  sharedTsConfig?: NuxtPrepareTypesConfig
  serverTsConfig?: NuxtPrepareTypesConfig
}

interface ResolvedDatabaseNuxtD1Options {
  bindingName: string
  contentDatabase: { bindingName: string, type: "d1" } | { filename: string, type: "sqlite" }
  d1Database?: ReturnType<typeof resolveCloudflareD1Binding>["d1Database"]
  unresolved?: ReturnType<typeof resolveCloudflareD1Binding>["unresolved"]
  viteOptions: DatabaseOptions
}

export function hubDatabase(options: DatabaseNuxtIntegrationOptions = {}): DatabaseNuxtModule {
  // SAFETY: This callback receives both required module metadata methods below before it is returned to Nuxt.
  const module = async function viteHubDatabaseNuxtModule(inlineOptions, nuxt) {
    // SAFETY: Nuxt supplies this module callback with its instance; NuxtLike describes only the options this integration reads.
    const nuxtOptions = (nuxt as NuxtLike).options
    const resolvedOptions = resolveDatabaseNuxtOptions(options, inlineOptions)
    if (resolvedOptions === false) {
      return
    }

    const root = resolveViteHubProjectRoot(resolve(nuxtOptions.rootDir || process.cwd()), {
      projectRoot: resolvedOptions.projectRoot,
    })
    const viteConfig = ensureRecord(nuxtOptions, "vite")
    const provisionRoot = resolve(nuxtOptions.rootDir || process.cwd(), nuxtOptions.vite?.root ?? ".")
    const generatedRoot = resolveViteHubGeneratedRoot({
      [VITEHUB_GENERATED_ROOT]: typeof viteConfig[VITEHUB_GENERATED_ROOT] === "string"
        ? viteConfig[VITEHUB_GENERATED_ROOT]
        : nuxtOptions.buildDir
          ? resolve(nuxtOptions.buildDir, "vitehub")
          : undefined,
      root,
    })
    const serverDirs = resolvedOptions.projectRoot
      ? [resolve(root, "server")]
      : resolveNuxtServerDirs(nuxtOptions)
    const databaseConfig = resolvedOptions.driver === "d1"
      ? resolveDBViteConfig(resolvedOptions, root, { provisionRoot, serverDirs })
      : undefined
    const sourceMigrationsDir = databaseConfig && databaseConfig.definitionDefaults.cloudflareProjections.default?.resource === "inherited"
      ? databaseConfig.databases.default?.migrationsDir
      : undefined
    const sourceMigrationsTarget = sourceMigrationsDir
      ? `${generatedNitroMigrationsDir}/${resolveCloudflareD1BindingName("default", resolvedOptions.binding)}`
      : undefined
    const d1 = usesDefinitionResources(resolvedOptions, databaseConfig) ? undefined : resolveDatabaseNuxtD1Options(
      resolvedOptions,
      nuxtOptions,
      sourceMigrationsTarget,
      resolveDatabaseNuxtProvisionState(
        readProvisionStateSync(provisionRoot),
        resolvedOptions.databaseName,
      ),
    )
    const effectiveOptions = d1 ? { ...resolvedOptions, binding: d1.bindingName } : resolvedOptions
    const runtimeOptions = d1?.d1Database
      ? {
          ...effectiveOptions,
          databaseId: withConfigValueFallback(resolvedOptions.databaseId, d1.d1Database.database_id),
        }
      : effectiveOptions
    const viteOptions = resolveDatabaseViteOptions({ ...runtimeOptions, projectRoot: root }, serverDirs)
    if (viteOptions) {
      const configuredDatabase = getResolvedFeatureOptions<Record<string, unknown>>(viteConfig, "database")
      setResolvedFeatureOptions(viteConfig, "database", { ...configuredDatabase, ...viteOptions })
    }
    installVitePlugin(viteConfig, { ...runtimeOptions, projectRoot: root }, serverDirs)
    const hook = (nuxt as NuxtLike).hook
    if (typeof hook === "function") {
      hook("prepare:types", (context) => {
        const generatedTypes = resolve(root, generatedDatabaseTypesFile)
        context.references.push({ path: generatedTypes })
        if (!nuxtOptions.buildDir) return
        const relativeGeneratedTypes = relative(nuxtOptions.buildDir, generatedTypes)
        for (const tsConfig of [context.sharedTsConfig, context.serverTsConfig]) {
          if (!tsConfig) continue
          tsConfig.include = [...new Set([...(tsConfig.include ?? []), relativeGeneratedTypes])]
        }
      })
      let localNitroConfig: Record<string, unknown> | undefined
      let localRuntimeRefresh = Promise.resolve()
      let closed = false
      let contributions: CollectedDatabaseContributions = { definitions: [], tables: [], uses: [] }
      const definitionFiles = new Set<string>()
      const contributionFiles = new Set<string>()
      const contributionWatchers = new Map<string, FSWatcher>()
      const require = createRequire(pathToFileURL(resolve(root, "package.json")))
      const definitionDirectories = new Set([
        ...(serverDirs ?? [resolve(root, "server")]).map(directory => resolve(directory, "databases")),
        resolve(root, "src"),
      ])
      const refreshLocalRuntime = () => {
        const refresh = async () => {
          if (!localNitroConfig || closed) return
          const runtime = await installNitroLocalDatabaseRuntime(localNitroConfig, root, provisionRoot, generatedRoot, runtimeOptions, serverDirs, d1, contributions, undefined, true)
          for (const source of runtime?.definitions.flatMap(definition => definition.schemaSources) ?? []) {
            definitionFiles.add(source.handler)
            definitionDirectories.add(dirname(source.handler))
          }
          for (const contribution of contributions.tables) {
            try {
              const { module } = contribution.definition
              const file = isAbsolute(module) ? resolve(module) : require.resolve(module)
              await collectWatchedModuleFiles(file, require, contributionFiles)
            }
            catch {
              // The runtime loader reports unresolved contributions; there is no file to watch yet.
            }
          }
          nuxtOptions.watch = [...new Set([...(nuxtOptions.watch ?? []), ...definitionDirectories, ...definitionFiles, ...contributionFiles])]
          // Nuxt's builder ignores node_modules, so watch each resolved dependency directly.
          const installContributionWatcher = (watchedFile: string) => {
            if (closed || contributionWatchers.has(watchedFile)) return
            try {
              const watcher = watchFs(watchedFile, (eventType) => {
                if (eventType === "rename") {
                  watcher.close()
                  contributionWatchers.delete(watchedFile)
                  // Editors commonly replace files by rename; follow the new inode.
                  setTimeout(() => installContributionWatcher(watchedFile), 0)
                }
                // A watcher has no caller to reject to, so a failed refresh is reported and the last runtime stays.
                refreshLocalRuntime().catch(error => console.warn(`[vitehub] Database runtime refresh failed: ${error instanceof Error ? error.message : String(error)}`))
              })
              contributionWatchers.set(watchedFile, watcher)
            }
            catch {
              // The Nuxt watch list remains the fallback when native watching is unavailable.
            }
          }
          if (closed) return
          for (const watchedFile of contributionFiles) installContributionWatcher(watchedFile)
        }
        const queued = localRuntimeRefresh.then(refresh, refresh)
        localRuntimeRefresh = queued
        return queued
      }
      if (nuxtOptions.dev) {
        nuxtOptions.watch = [...new Set([...(nuxtOptions.watch ?? []), ...definitionDirectories])]
        hook("builder:watch", async (_event, path) => {
          const file = resolve(nuxtOptions.srcDir || nuxtOptions.rootDir || root, path)
          if (definitionFiles.has(file) || contributionFiles.has(file) || [...definitionDirectories].some(directory => file === directory || file.startsWith(`${directory}${sep}`))) {
            await refreshLocalRuntime()
          }
        })
        hook("close", () => {
          closed = true
          for (const watcher of contributionWatchers.values()) watcher.close()
          contributionWatchers.clear()
        })
      }
      // Nuxt 5 writes each Nitro alias with its file extension into `tsconfig.server.json`. TypeScript would then read
      // `db` from the generated runtime module, which is untyped JavaScript. Server code takes the package types instead.
      // Nuxt keeps a path that a module set first, and a later hook replaces the Nuxt path.
      hook("prepare:types", ({ serverTsConfig }) => {
        if (!serverTsConfig) return
        const paths = ensureRecord(ensureRecord(serverTsConfig, "compilerOptions"), "paths")
        paths[databaseRegistryImport] ??= [databaseRegistryTypes]
      })
      hook("nitro:config", async (config) => {
        // Vite plugins in the Nuxt config can contribute tables, as they do through `hubDatabase()` in a Vite app. Nuxt
        // modules add them to `nuxt.options.vite.plugins` during setup, so this hook sees them after every module ran.
        contributions = await collectDatabaseContributions(nuxtOptions.vite?.plugins, {
          projectRoot: root,
          root: resolve(nuxtOptions.srcDir || nuxtOptions.rootDir || root),
          rootDir: root,
          serverDirs,
        })
        const provider = resolveNitroHostingProvider(config, nuxtOptions)
        // `nuxt prepare` writes the same output as the build, so the types match, but it skips the checks that only
        // a deployable build needs. An app runs it in `postinstall`, before it has D1 resources.
        const building = !nuxtOptions.dev && !nuxtOptions._prepare
        if (building && provider === "cloudflare" && d1?.unresolved && !findCompleteNitroConfigD1Binding(config, d1.bindingName, d1.unresolved.databaseName)) {
          if (d1.unresolved.reason === "missing-database-name") {
            throw databaseErrorDiagnostics.DATABASE_MISSING_D1_RESOURCE({ databases: [d1.unresolved.database], missing: "`database.databaseName`" })
          }
          throw databaseErrorDiagnostics.DATABASE_MISSING_D1_RESOURCE({ databases: [d1.unresolved.database], missing: "`database.databaseId` or provision state" })
        }
        if (!nuxtOptions.dev && provider) mergeNitroHostedCondition(config)
        if (nuxtOptions.dev) {
          localNitroConfig = config
          await refreshLocalRuntime()
        }
        if (d1) {
          mergeNitroRuntimeContentConfig(config, d1)
          mergeNitroConfigCloudflareConfig(config, d1)
        }
        if (!nuxtOptions.dev) {
          const runtime = resolveDBViteConfig(runtimeOptions, root, {
            contributions,
            implicitDefault: true,
            provisionRoot,
            serverDirs,
          })
          // Production output has no PGlite.
          const pglite = building && runtime ? pgliteDatabases(runtime) : []
          if (pglite.length) throw databaseErrorDiagnostics.DATABASE_PGLITE_IN_BUILD({ databases: pglite })
          if (building && provider === "cloudflare") {
            assertDistinctNuxtD1Bindings(runtime, d1, config)
            // Without a D1 resource, the Vite build removes the hosted runtime and Nitro cannot load the
            // `@vite-hub/database/runtime/registry` alias. An alias that the app sets does not load that runtime.
            if (runtime && !(isRecord(config.alias) && databaseRegistryImport in config.alias)) assertDefinitionD1Resources(runtime, contributions)
          }
          const d1Only = runtime && usesD1HttpOnly(runtime)
          // A separate Nuxt Content D1 resource does not make Node's local Databases hosted.
          const runtimeProvider = provider === "vercel" ? "vercel" : provider === "cloudflare" || d1Only || (provider && d1) ? "cloudflare" : provider
          // A hosted Definition runtime without a remote libSQL URL reaches D1 only, so the build ships no libSQL client.
          if (runtime && (runtimeProvider === "cloudflare" || runtimeProvider === "vercel") && !usesRemoteLibsql(runtime)) {
            const alias = ensureRecord(config, "alias")
            alias["#vitehub/database/definition-runtime"] ??= resolveRuntimeModule(resolve(databaseRuntimeDir, "../.."), "runtime/d1")
          }
          // `nuxt prepare` runs no Vite build, so generated types must exist on every preset after this hook.
          if (runtime) {
            await writeGeneratedDatabaseArtifacts(runtime, {
              alias: nuxtOptions.alias,
              onFallback: message => console.warn(message),
            })
          }
          else {
            // Keep Nuxt's unconditional type reference valid when no Database Definition exists.
            await removeGeneratedDatabaseTypes(root)
          }
          if (runtime && (runtimeProvider === "cloudflare" || runtimeProvider === "vercel")) {
            if (building) assertHostedDatabaseRuntimeResources(runtime, [runtimeProvider])
            await writeHostedDatabaseRuntimeModules(resolve(root, ".vitehub/database"), runtime, [runtimeProvider])
          }
          const migrateOnStart = resolveMigrateOnStart(resolvedOptions)
          const host = { hosting: nuxtOptions.nitro?.preset, nitro: config }
          const preset = resolveHostPreset(host)
          // Without a preset here, Nitro detects the host later. The default then takes the Postgres databases, and a
          // Nitro module adds the plugin only when the detected host is Node. An explicit option treats it as Node.
          const startHost = preset ? resolveHost(host) ?? preset : migrateOnStart?.explicit ? undefined : "node"
          const startDatabases = migrateOnStart ? selectMigrateOnStartDatabases(runtime, migrateOnStart, startHost) : []
          if (!runtimeProvider) {
            // Nuxt CLI clears buildDir after nitro:config, before compiling the generated runtime.
            const localRuntime = await installNitroLocalDatabaseRuntime(config, root, provisionRoot, resolve(root, ".vitehub"), runtimeOptions, serverDirs, d1, contributions, startDatabases.length ? runtime : undefined)
            if (migrateOnStart && startDatabases.length && localRuntime) await installNitroMigrateOnStart(config, root, localRuntime, migrateOnStart, startDatabases)
          }
          // The D1 bindings whose migrations the build copies into the server output.
          const migratedBindings: string[] = []
          if (provider === "cloudflare" && runtime) {
            mergeNitroConfigHyperdriveBindings(config, resolveCloudflareHyperdriveBindings(runtime))
            const { d1Databases, unresolved } = resolveCloudflareD1Bindings(runtime, { provisionState: readProvisionStateSync(provisionRoot) })
            for (const binding of unresolved) {
              if (hasRemoteDefinitionRuntime(runtime.databases[binding.database]!)) continue
              if (d1 && binding.binding === d1.bindingName && runtime.definitionDefaults.cloudflareProjections[binding.database]?.resource === "inherited" && findCompleteNitroConfigD1Binding(config, d1.bindingName, d1.unresolved?.databaseName)) continue
              if (!building) continue
              const missing = binding.reason === "missing-database-name" ? "`cloudflare.databaseName`" : "`cloudflare.databaseId` or provision state"
              throw databaseErrorDiagnostics.DATABASE_MISSING_D1_RESOURCE({ databases: [binding.database], missing })
            }
            const bindings = d1Databases.filter(binding => !(d1 && binding.binding === d1.bindingName && runtime.definitionDefaults.cloudflareProjections.default?.resource === "inherited"))
            const wrangler = ensureRecord(ensureRecord(config, "cloudflare"), "wrangler")
            wrangler.d1_databases = mergeCloudflareD1Bindings(wrangler.d1_databases, bindings.map(binding => ({
              ...binding,
              migrations_dir: `${generatedNitroMigrationsDir}/${binding.binding}`,
            })))
            const inheritedSource = d1 && runtime.definitions.some(definition => definition.name === "default") && runtime.definitionDefaults.cloudflareProjections.default?.resource === "inherited"
              ? runtime.databases.default?.migrationsDir
              : undefined
            const migrationCopies: Array<{ source: string, target: string }> = []
            if (d1 && inheritedSource) {
              const inheritedBinding = findCompleteNitroConfigD1Binding(config, d1.bindingName, d1.unresolved?.databaseName)
              if (inheritedBinding) {
                const target = typeof inheritedBinding.migrations_dir === "string" ? inheritedBinding.migrations_dir : `${generatedNitroMigrationsDir}/${d1.bindingName}`
                inheritedBinding.migrations_dir = target
                migrationCopies.push({ source: resolve(root, inheritedSource), target })
                migratedBindings.push(d1.bindingName)
              }
            }
            for (const binding of bindings) {
              if (!binding.migrations_dir) continue
              migrationCopies.push({ source: resolve(root, binding.migrations_dir), target: `${generatedNitroMigrationsDir}/${binding.binding}` })
              migratedBindings.push(binding.binding)
            }
            // Copy callbacks remove their entire target, so aliases and nested targets cannot be shared.
            const managedTargets = new Set(migrationCopies.map(copy => resolve(root, copy.target)))
            const targets = (wrangler.d1_databases as Array<{ binding: string, migrations_dir?: string }>).map(binding => ({
              binding: binding.binding,
              path: resolve(root, binding.migrations_dir ?? "migrations"),
            }))
            for (let index = 0; index < targets.length; index++) {
              const target = targets[index]!
              for (const other of targets.slice(index + 1)) {
                if (!managedTargets.has(target.path) && !managedTargets.has(other.path)) continue
                if (target.path === other.path || target.path.startsWith(`${other.path}${sep}`) || other.path.startsWith(`${target.path}${sep}`)) {
                  throw new Error(`D1 migration directories overlap for bindings ${target.binding} and ${other.binding}; configure an exclusive migrations_dir for each binding.`)
                }
              }
            }
            for (const copy of migrationCopies) installNitroCloudflareMigrations(config, copy.source, copy.target)
            installNitroCloudflareD1BindingCollapse(config)
          }
          if (building && resolvedOptions.migrateOnDeploy) installNitroMigrateOnDeploy(config, { bindings: migratedBindings, config: runtime })
          mergeNitroDatabaseRuntimeAlias(config, root, runtimeProvider)
          if (runtime) installNitroBundleStartupRule(config, runtime)
        }
        if (!nuxtOptions.dev && provider === "cloudflare") {
          await installNitroCloudflareEnvBridge(config, root)
          if (building && hasNuxtContentModule(nuxtOptions.modules) && !d1) {
            const content = isRecord(nuxtOptions.content) ? nuxtOptions.content : undefined
            const database = content && isRecord(content.database) ? content.database : undefined
            const bindingName = database?.type === "d1" && typeof database.bindingName === "string" ? database.bindingName : "DB"
            if ((!database || database.type === "sqlite" || database.type === "d1") && !findCompleteNitroConfigD1Binding(config, bindingName)) {
              throw new Error("Nuxt Content on Cloudflare requires an explicit content.database configuration or a complete Wrangler D1 binding named DB.")
            }
          }
        }
        await installNitroRequestStats(config, root, provider)
      })
    }

    if (!d1) return
    mergeNuxtContentConfig(nuxtOptions, d1)
    mergeNitroCloudflareConfig(nuxtOptions, d1)
  } as DatabaseNuxtModule

  module.getMeta = () => ({
    configKey: "database",
    name: "@vite-hub/database/nuxt",
  })
  module.getModuleDependencies = nuxt => resolveNuxtContentModuleDependencies(options, nuxt)

  return module
}

function resolveDatabaseNuxtProvisionState(provisionState: ReturnType<typeof readProvisionStateSync>, databaseName: unknown) {
  const resolvedDatabaseName = resolveConfigValue(databaseName as Parameters<typeof resolveConfigValue>[0])?.trim()
  if (!resolvedDatabaseName) return
  const databaseId = provisionState.cloudflare?.d1Nuxt?.[getDatabaseNuxtProvisionStateKey(resolvedDatabaseName)]
  return databaseId ? { cloudflare: { d1: { default: databaseId } } } : undefined
}

async function collectWatchedModuleFiles(file: string, require: NodeRequire, files: Set<string>, seen = new Set<string>()) {
  file = resolve(file)
  if (seen.has(file)) return
  seen.add(file)
  files.add(file)
  const loaded = require.cache?.[file]
  for (const child of loaded?.children ?? []) await collectWatchedModuleFiles(child.filename, require, files, seen)
  let source: string
  try { source = await readFile(file, "utf8") } catch { return }
  const imports = source.matchAll(/(?:from\s*["']|import\s*\(\s*["']|import\s*["']|export\s+[^;]*?from\s*["'])([^"']+)["']/g)
  for (const match of imports) {
    try {
      const resolved = resolveSourceImport(match[1]!, file, require)
      if (resolved) await collectWatchedModuleFiles(resolved, require, files, seen)
    }
    catch { /* unresolved aliases are handled by Nuxt */ }
  }
}

async function installNitroLocalDatabaseRuntime(
  config: Record<string, unknown>,
  root: string,
  provisionRoot: string,
  generatedRoot: string,
  options: ResolvedDatabaseNuxtIntegrationOptions,
  serverDirs?: string[],
  d1?: ResolvedDatabaseNuxtD1Options,
  contributions: CollectedDatabaseContributions = { definitions: [], tables: [], uses: [] },
  resolvedRuntime?: ResolvedDBViteConfig,
  /** True for `nuxt dev`, where a Definition's `remote` switch applies. */
  dev = false,
) {
  const file = resolve(generatedRoot, generatedNitroLocalDatabaseRuntime)
  const migrationsFile = resolve(generatedRoot, generatedNitroShippedMigrations)
  const defaultsFile = resolve(generatedRoot, "database/definition-defaults.mjs")
  const alias = isRecord(config.alias) ? config.alias : undefined
  const existingAlias = alias?.[databaseRegistryImport]
  const customRegistry = !!existingAlias && existingAlias !== file
  if (customRegistry) {
    await Promise.all([rm(file, { force: true }), rm(migrationsFile, { force: true })])
    if (!dev) return
  }

  const runtime = resolvedRuntime ?? resolveDBViteConfig(options, root, { contributions, provisionRoot, serverDirs })
  assertDistinctNuxtD1Bindings(runtime, d1, config)
  if (!runtime?.definitions.length) {
    await Promise.all([rm(file, { force: true }), rm(migrationsFile, { force: true })])
    if (dev) {
      await rm(defaultsFile, { force: true })
      if (alias?.[databaseDefinitionDefaultsImport] === defaultsFile) delete alias[databaseDefinitionDefaultsImport]
    }
    if (alias && existingAlias === file) {
      delete alias[databaseRegistryImport]
      if (!Object.keys(alias).length) delete config.alias
    }
    return
  }

  const definitionDefaults = serializeGeneratedRegistry(dev ? { ...runtime.definitionDefaults, dev: true } : runtime.definitionDefaults)
  if (dev) {
    // Direct Definition imports need these defaults even when the app supplies its own registry.
    await writeFileIfChanged(defaultsFile, `export default ${definitionDefaults}\n`)
    ensureRecord(config, "alias")[databaseDefinitionDefaultsImport] ??= defaultsFile
  }
  if (customRegistry) return runtime

  // Nitro dev keeps running when a Definition needs Nuxt auto-imports to load; collisions are then checked on literal keys.
  const tableNameOptions = {
    alias: isRecord(config.alias)
      ? Object.fromEntries(Object.entries(config.alias).filter((entry): entry is [string, string] => String(entry[1]) === entry[1]))
      : undefined,
    onFallback: (message: string) => console.warn(message),
  }
  const loadedContributionsByDatabase = new Map<string, Set<CollectedDatabaseContribution>>()
  for (const definition of runtime.definitions) {
    const sourceSchemas = await loadDefinitionSchemas(definition, tableNameOptions)
    const parts = [{ schema: mergeLoadedSchemas(sourceSchemas), owner: `Database Definition ${definition.handler}` }]
    const loadedContributions = new Set<CollectedDatabaseContribution>()
    for (const contribution of runtime.tableContributionsByDatabase[definition.name] ?? []) {
      const schema = await loadContributedDatabaseSchema(contribution, file, tableNameOptions)
      if (schema.loaded) loadedContributions.add(contribution)
      parts.push({ schema, owner: `contributed tables ${describeDatabaseContribution(contribution)}` })
    }
    loadedContributionsByDatabase.set(definition.name, loadedContributions)
    assertDistinctLoadedSchemas(definition.name, parts)
  }

  // Nuxt layers and contributed tables add tables to one database, so the runtime uses the merged schema.
  const contributedSchemas = runtime.definitions.map((definition, index) =>
    (runtime.tableContributionsByDatabase[definition.name] ?? []).flatMap((contribution, contributionIndex) =>
      loadedContributionsByDatabase.get(definition.name)?.has(contribution)
        ? [{ contribution, relationsVariable: `contributedRelations_${index}_${contributionIndex}`, variable: `contributedSchema_${index}_${contributionIndex}` }]
        : []))
  const layered = (definition: (typeof runtime.definitions)[number]) => definition.schemaSources.length > 1
  const merged = (index: number) => layered(runtime.definitions[index]!) || contributedSchemas[index]!.length > 0
  // A Definition that jiti cannot load still runs: Nitro resolves its aliases and Nuxt auto-imports.
  const imports = runtime.definitions.flatMap((definition, index) => [
    `import definition_${index} from ${JSON.stringify(pathToFileURL(definition.handler).href)}`,
    ...layered(definition)
      ? definition.schemaSources.map((source, sourceIndex) =>
          `import schemaSource_${index}_${sourceIndex} from ${JSON.stringify(pathToFileURL(source.handler).href)}`)
      : [],
    ...contributedSchemas[index]!.flatMap(({ contribution, relationsVariable, variable }) => [
      renderContributionImport(file, contribution, variable),
      ...contribution.relations ? [renderContributionRelationsImport(file, contribution, relationsVariable)] : [],
    ]),
  ])
  const schemas = runtime.definitions.flatMap((definition, index) => {
    if (!merged(index)) return []
    const definitionSchemas = layered(definition)
      ? definition.schemaSources.map((_, sourceIndex) => `...schemaSource_${index}_${sourceIndex}.schema`)
      : [`...definition_${index}.schema`]
    return [`const schema_${index} = { ${[...definitionSchemas, ...contributedSchemas[index]!.map(({ variable }) => `...${variable}`)].join(", ")} }`]
  })
  // Each database gets the relations of its contributed tables and of each layer, so `db.query` follows them.
  const relations = runtime.definitions.map((definition, index) => `const relations_${index} = ${renderMergedRelations(
    definition.name,
    merged(index) ? `schema_${index}` : `definition_${index}.schema`,
    contributedSchemas[index]!.flatMap(({ contribution, relationsVariable }) => contribution.relations ? [relationsVariable] : []),
    layered(definition) ? definition.schemaSources.map((_, sourceIndex) => `schemaSource_${index}_${sourceIndex}`) : [`definition_${index}`],
  )}`)
  const entries = runtime.definitions.map((definition, index) => [
    `  [${JSON.stringify(definition.name)}]: {`,
    runtime.databases[definition.name]?.dialect === "postgresql"
      ? `    db: ${renderPostgresDatabaseExpression(definition.name, runtime, `definition_${index}`, merged(index) ? `schema_${index}` : `definition_${index}.schema`, `relations_${index}`, dev)},`
      : `    db: createDefinitionRuntime({ ...definition_${index}, ${merged(index) ? `schema: schema_${index}, ` : ""}relations: relations_${index} }, definitionDefaults),`,
    `    relations: relations_${index},`,
    `    schema: ${merged(index) ? `schema_${index}` : `definition_${index}.schema`},`,
    "  },",
  ].join("\n"))
  // `ensureMigrations()` and the start plugin apply the migrations that this module ships.
  await writeFileIfChanged(migrationsFile, renderShippedMigrationsModule(runtime, { allowDataLoss: resolveMigrateOnStart(options)?.allowDataLoss ?? false }))
  await writeFileIfChanged(file, renderDatabaseRuntimeModule({
    chunkParametersImport: pathToFileURL(resolve(databaseRuntimeDir, "chunk-parameters.js")).href,
    createAgentDatabaseImport: pathToFileURL(resolve(databaseRuntimeDir, "agent.js")).href,
    databaseEntries: entries,
    ensureMigrationsImport: pathToFileURL(resolve(databaseRuntimeDir, "migrate-on-start.js")).href,
    migrations: { import: pathToFileURL(migrationsFile).href },
    imports: [
      `import { createDefinitionRuntime } from ${JSON.stringify(pathToFileURL(resolve(databaseRuntimeDir, "definition-local.js")).href)}`,
      `import { mergeDatabaseRelations } from ${JSON.stringify(pathToFileURL(resolve(databaseRuntimeDir, "relations.js")).href)}`,
      ...(usesPostgres(runtime)
        ? [dev
            ? `import { createDevPostgresDatabase } from ${JSON.stringify(pathToFileURL(resolve(databaseRuntimeDir, "pglite.js")).href)}`
            : `import { createPostgresDatabase } from ${JSON.stringify(pathToFileURL(resolve(databaseRuntimeDir, "postgres.js")).href)}`]
        : []),
      ...imports,
      "",
      `const definitionDefaults = ${definitionDefaults}`,
    ],
    setup: [...schemas, ...relations],
    useDatabaseImport: pathToFileURL(resolve(databaseRuntimeDir, "use-database.js")).href,
  }))
  ensureRecord(config, "alias")[databaseRegistryImport] = file
  return runtime
}

function resolveNuxtContentModuleDependencies(options: DatabaseNuxtIntegrationOptions, nuxt: unknown): NuxtModuleDependencies {
  const nuxtOptions = (nuxt as NuxtLike).options
  const resolvedOptions = resolveDatabaseNuxtOptions(options, undefined)
  if (resolvedOptions === false || !hasNuxtContentModule(nuxtOptions.modules)) {
    return {}
  }

  const root = resolveViteHubProjectRoot(resolve(nuxtOptions.rootDir || process.cwd()), resolvedOptions)
  const serverDirs = resolvedOptions.projectRoot ? [resolve(root, "server")] : resolveNuxtServerDirs(nuxtOptions)
  if (usesDefinitionResources(resolvedOptions, resolveDBViteConfig(resolvedOptions, root, { serverDirs }))) return {}
  const d1 = resolveDatabaseNuxtD1Options(resolvedOptions, nuxtOptions)
  if (!d1) return {}

  return {
    "@nuxt/content": {
      overrides: {
        database: d1.contentDatabase,
      },
    },
  }
}

function usesDefinitionResources(options: ResolvedDatabaseNuxtIntegrationOptions, config: ResolvedDBViteConfig | undefined) {
  // An inferred D1 driver does not declare an extra host resource beside discovered Definitions.
  return Boolean(config && options.binding === undefined && options.databaseId === undefined && options.databaseName === undefined)
}

/** `vite-hub/nuxt` passes the Database options from its `vitehub` key. A top-level Nuxt `database` key is not read. */
function resolveDatabaseNuxtOptions(
  options: DatabaseNuxtIntegrationOptions,
  inlineOptions: DatabaseNuxtIntegrationOptions | undefined,
): ResolvedDatabaseNuxtIntegrationOptions | false {
  if (options === false || inlineOptions === false) {
    return false
  }
  return {
    ...(isRecord(options) ? options : {}),
    ...(isRecord(inlineOptions) ? inlineOptions : {}),
  } as ResolvedDatabaseNuxtIntegrationOptions
}

function resolveDatabaseViteOptions(options: ResolvedDatabaseNuxtIntegrationOptions, serverDirs?: string[]): DatabaseOptions | undefined {
  const viteOptions: Exclude<DatabaseOptions, false> & NuxtDatabaseViteOptions = { nuxtHostResource: true }
  if (options.projectRoot) {
    viteOptions.projectRoot = options.projectRoot
  }
  if (serverDirs) {
    viteOptions.nuxtServerDirs = serverDirs
  }
  if ("cli" in options) {
    viteOptions.cli = options.cli
  }
  if (options.connection) {
    viteOptions.connection = options.connection
  }
  if (options.driver === "d1") {
    viteOptions.driver = "d1"
    viteOptions.binding = options.binding
    viteOptions.databaseId = options.databaseId
    viteOptions.databaseName = options.databaseName
    viteOptions.cloudflare = options.cloudflare
    viteOptions.local = options.local
    viteOptions.migrationsTable = options.migrationsTable
    viteOptions.previewDatabaseId = options.previewDatabaseId
    viteOptions.readReplication = options.readReplication
  }
  return Object.keys(viteOptions).length ? viteOptions : undefined
}

function resolveDatabaseNuxtD1Options(
  options: ResolvedDatabaseNuxtIntegrationOptions,
  nuxtOptions: NuxtLike["options"],
  migrationsDir?: string,
  provisionState?: NonNullable<Parameters<typeof resolveCloudflareD1Binding>[1]>["provisionState"],
): ResolvedDatabaseNuxtD1Options | undefined {
  if (options.driver !== "d1") return

  const projection = resolveCloudflareD1Binding({
    binding: options.binding,
    database: "default",
    databaseId: options.databaseId,
    databaseName: options.databaseName,
    migrationsDir,
    migrationsTable: options.migrationsTable,
    previewDatabaseId: options.previewDatabaseId,
  }, { provisionState })

  return {
    bindingName: projection.bindingName,
    contentDatabase: nuxtOptions.dev
      ? {
          type: "sqlite",
          filename: options.local?.filename ?? ".vitehub/data/database/content.sqlite",
        }
      : {
          type: "d1",
          bindingName: projection.bindingName,
        },
    ...(projection.d1Database ? { d1Database: projection.d1Database } : {}),
    ...(projection.unresolved ? { unresolved: projection.unresolved } : {}),
    viteOptions: resolveDatabaseViteOptions(options) ?? {},
  }
}

function installVitePlugin(viteConfig: Record<string, unknown>, options: ResolvedDatabaseNuxtIntegrationOptions, serverDirs?: string[]) {
  const plugins = Array.isArray(viteConfig.plugins) ? viteConfig.plugins : []
  if (!plugins.some(plugin => isRecord(plugin) && plugin.name === "@vite-hub/database/vite")) {
    viteConfig.plugins = [hubDatabaseVite(resolveDatabaseViteOptions(options, serverDirs)), ...plugins] satisfies Plugin[]
  }
}

function mergeNuxtContentConfig(config: Record<string, unknown>, d1: ResolvedDatabaseNuxtD1Options) {
  const content = ensureRecord(config, "content")
  content.database = d1.contentDatabase
}

function mergeNitroRuntimeContentConfig(config: Record<string, unknown>, d1: ResolvedDatabaseNuxtD1Options) {
  const runtimeConfig = ensureRecord(config, "runtimeConfig")
  const content = ensureRecord(runtimeConfig, "content")
  content.database = d1.contentDatabase
}

function mergeNitroHostedCondition(config: Record<string, unknown>) {
  const conditions = Array.isArray(config.exportConditions) ? config.exportConditions : []
  if (!conditions.includes("vitehub-hosted")) {
    config.exportConditions = ["vitehub-hosted", ...conditions]
  }
}

function mergeNitroDatabaseRuntimeAlias(
  config: Record<string, unknown>,
  root: string,
  provider: string | undefined,
) {
  if (provider !== "cloudflare" && provider !== "vercel") return
  const alias = ensureRecord(config, "alias")
  if (!(databaseDefinitionDefaultsImport in alias)) {
    alias[databaseDefinitionDefaultsImport] = resolve(root, ".vitehub/database/definition-defaults.mjs")
  }
  if (!(databaseRegistryImport in alias)) {
    alias[databaseRegistryImport] = resolve(root, `.vitehub/database/${provider}-runtime.mjs`)
  }
}

function resolveNitroHostingProvider(config: Record<string, unknown>, nuxtOptions: NuxtLike["options"]) {
  const host = resolveHost({ hosting: nuxtOptions.nitro?.preset, nitro: config })
  return host === "node" ? undefined : host
}

async function installNitroCloudflareEnvBridge(config: Record<string, unknown>, root: string) {
  const kit = createNitroServerKit(config)
  // No route: Nitro runs route-less middleware for every request.
  kit.addHandler({ handler: generatedNitroDatabaseMiddleware, middleware: true }, "start")
  config.handlers = kit.config.handlers
  const rollupConfig = isRecord(config.rollupConfig) ? { ...config.rollupConfig } : {}
  rollupConfig.external = mergeNitroExternal(rollupConfig.external, "cloudflare:workers")
  config.rollupConfig = rollupConfig
  await writeFileIfChanged(resolve(root, generatedNitroDatabaseMiddleware), [
    "import { env as vitehubEnv } from 'cloudflare:workers'",
    "import { getRequestCloudflareEnv, runWithActiveCloudflareEnv, runWithDatabaseRequest, setActiveCloudflareEnv } from '@vite-hub/database/runtime/state'",
    "",
    "const nativeEnv = (globalThis as typeof globalThis & { __env__?: Record<string, unknown> }).__env__ ?? vitehubEnv",
    "",
    "// Running next() inside the env scope gives each request its own database clients and D1 sessions.",
    "export default (event: Parameters<typeof getRequestCloudflareEnv>[0], next: () => unknown) => {",
    "  const mergedEnv = Object.assign({}, nativeEnv, getRequestCloudflareEnv(event))",
    "  for (const property of Reflect.ownKeys(nativeEnv)) {",
    "    if (!Object.hasOwn(mergedEnv, property)) Object.defineProperty(mergedEnv, property, { configurable: true, get: () => Reflect.get(nativeEnv as object, property) })",
    "  }",
    "  const env = new Proxy(mergedEnv, { get: (target, property, receiver) => Reflect.has(target, property) ? Reflect.get(target, property, receiver) : undefined })",
    "  setActiveCloudflareEnv(env)",
    "  return runWithActiveCloudflareEnv(env, () => runWithDatabaseRequest(event, next))",
    "}",
    "",
  ].join("\n"))
}

/** Each request's database calls go on its evlog wide event (`database`), on every host and in `nuxt dev`. */
async function installNitroRequestStats(config: Record<string, unknown>, root: string, provider?: string) {
  // Nitro's hook receives the resolved options object without Nuxt's preset. Use
  // the provider resolved before the hook so incidental Cloudflare config on
  // another preset cannot enable Cloudflare-only compatibility flags.
  if (provider === "cloudflare") {
    const cloudflare = ensureRecord(config, "cloudflare")
    const wrangler = ensureRecord(cloudflare, "wrangler")
    const flags = Array.isArray(wrangler.compatibility_flags) ? [...wrangler.compatibility_flags] : []
    if (!flags.includes("nodejs_als")) flags.push("nodejs_als")
    wrangler.compatibility_flags = flags
  }
  const kit = createNitroServerKit(config)
  kit.addHandler({ handler: generatedNitroRequestStatsMiddleware, middleware: true }, "start")
  config.handlers = kit.config.handlers
  await writeFileIfChanged(resolve(root, generatedNitroRequestStatsMiddleware), [
    `import { runWithDatabaseRequestStats } from ${JSON.stringify(resolveRuntimeModule(resolve(databaseRuntimeDir, "../.."), "runtime/request-stats"))}`,
    "",
    "export default (event: unknown, next: () => unknown) => runWithDatabaseRequestStats(event, next)",
    "",
  ].join("\n"))
}

/** Applies pending migrations when the Node server starts. `@vite-hub/database/runtime/registry` is the local runtime alias here. */
async function installNitroMigrateOnStart(config: Record<string, unknown>, root: string, runtime: ResolvedDBViteConfig, settings: MigrateOnStartSettings, databases: string[]) {
  const file = resolve(root, migrateOnStartPluginFile)
  const plugin = renderMigrateOnStartPlugin(runtime, {
    databases,
    registryImport: databaseRegistryImport,
    migrationsImport: pathToFileURL(resolve(root, ".vitehub", generatedNitroShippedMigrations)).href,
    runtimeImport: pathToFileURL(resolve(databaseRuntimeDir, "migrate-on-start.js")).href,
  })
  if (!plugin) return
  await writeFileIfChanged(file, plugin)
  if (settings.explicit) {
    const kit = createNitroServerKit(config)
    kit.addPlugin(file)
    config.plugins = kit.config.plugins
    return
  }
  // Nitro resolves the preset, with its host detection, before it runs modules. The default migrates only on Node.
  const modules = Array.isArray(config.modules) ? [...config.modules] : []
  modules.push((nitro: { options: { plugins?: string[], preset?: string } }) => {
    if (resolveHost({ nitro: nitro.options }) !== "node") return
    const plugins = nitro.options.plugins ??= []
    if (!plugins.includes(file)) plugins.push(file)
  })
  config.modules = modules
}

function installNitroCloudflareMigrations(config: Record<string, unknown>, sourceDir: string, targetDir = generatedNitroMigrationsDir) {
  const normalizedTarget = relative(resolve("."), resolve(targetDir))
  if (isAbsolute(targetDir) || normalizedTarget === "" || normalizedTarget === ".." || normalizedTarget.startsWith(`..${sep}`)) {
    throw new Error("D1 migrations_dir must be a relative directory inside Nitro's server output.")
  }
  const modules = Array.isArray(config.modules) ? [...config.modules] : []
  modules.push((nitro: {
    hooks: { hook: (name: "compiled", callback: () => Promise<void>) => void }
    options: { output: { serverDir: string } }
  }) => {
    nitro.hooks.hook("compiled", async () => {
      const outputDir = resolve(nitro.options.output.serverDir, targetDir)
      await rm(outputDir, { force: true, recursive: true })
      await copyD1MigrationFiles(sourceDir, outputDir)
    })
  })
  config.modules = modules
}

/** Puts the D1 migrations before the Cloudflare deploy command. Nitro checks the host when it builds. */
function installNitroMigrateOnDeploy(config: Record<string, unknown>, target: { bindings: string[], config: ResolvedDBViteConfig | undefined }) {
  const modules = Array.isArray(config.modules) ? [...config.modules] : []
  modules.push((nitro: MigrateOnDeployNitro) => installMigrateOnDeploy(nitro, () => target))
  config.modules = modules
}

/** Tells `@vite-hub/bundle` which packages this build never runs at server startup. */
function installNitroBundleStartupRule(config: Record<string, unknown>, runtime: ResolvedDBViteConfig) {
  const modules = Array.isArray(config.modules) ? [...config.modules] : []
  modules.push((nitro: {
    hooks: { hook: (name: "vitehub:bundle:rules", callback: (rules: DatabaseBundleStartupRule[]) => void) => void }
    options: { preset?: string }
  }) => {
    nitro.hooks.hook("vitehub:bundle:rules", (rules) => {
      const rule = libsqlStartupRule(runtime, nitro.options.preset)
      if (rule) rules.push(rule)
    })
  })
  config.modules = modules
}

/** Nitro merges a project wrangler.json into its output after this config, so a binding both declare appears twice. */
function installNitroCloudflareD1BindingCollapse(config: Record<string, unknown>) {
  const modules = Array.isArray(config.modules) ? [...config.modules] : []
  modules.push((nitro: {
    hooks: { hook: (name: "compiled", callback: () => Promise<void>) => void }
    options: { output: { serverDir: string } }
  }) => {
    nitro.hooks.hook("compiled", () => collapseGeneratedWranglerD1Bindings(nitro.options.output.serverDir))
  })
  config.modules = modules
}

function mergeNitroCloudflareConfig(config: Record<string, unknown>, d1: ResolvedDatabaseNuxtD1Options) {
  if (!d1.d1Database) return
  const nitro = ensureRecord(config, "nitro")
  const cloudflare = ensureRecord(nitro, "cloudflare")
  const wrangler = ensureRecord(cloudflare, "wrangler")
  const flags = Array.isArray(wrangler.compatibility_flags) ? [...wrangler.compatibility_flags] : []
  if (!flags.includes("nodejs_als")) flags.push("nodejs_als")
  wrangler.compatibility_flags = flags
  wrangler.d1_databases = mergeCloudflareD1Bindings(wrangler.d1_databases, [d1.d1Database])
}

function mergeNitroConfigHyperdriveBindings(config: Record<string, unknown>, bindings: ReturnType<typeof resolveCloudflareHyperdriveBindings>) {
  if (!bindings.length) return
  const wrangler = ensureRecord(ensureRecord(config, "cloudflare"), "wrangler")
  wrangler.hyperdrive = mergeCloudflareHyperdriveBindings(wrangler.hyperdrive, bindings)
}

function mergeNitroConfigCloudflareConfig(config: Record<string, unknown>, d1: ResolvedDatabaseNuxtD1Options) {
  if (!d1.d1Database) return
  const cloudflare = ensureRecord(config, "cloudflare")
  const wrangler = ensureRecord(cloudflare, "wrangler")
  wrangler.d1_databases = mergeCloudflareD1Bindings(wrangler.d1_databases, [d1.d1Database])
}

function assertDistinctNuxtD1Bindings(runtime: ReturnType<typeof resolveDBViteConfig>, d1: ResolvedDatabaseNuxtD1Options | undefined, config: Record<string, unknown>) {
  if (!runtime || !d1) return
  const host = d1.d1Database ?? findCompleteNitroConfigD1Binding(config, d1.bindingName, d1.unresolved?.databaseName)
  for (const name of runtime.databaseNames) {
    const projection = runtime.definitionDefaults.cloudflareProjections[name]
    if (projection?.resource !== "configured" || projection.binding !== d1.bindingName) continue
    const definition = runtime.databases[name]?.cloudflare
    if (host && definition?.databaseId === host.database_id && definition?.databaseName === host.database_name) continue
    throw databaseErrorDiagnostics.DATABASE_BINDING_CONFLICT({ binding: d1.bindingName, first: `The Database Definition "${name}"`, kind: "D1", second: "the Nuxt host resource" })
  }
}

function findCompleteNitroConfigD1Binding(config: Record<string, unknown>, bindingName: string, databaseName?: string) {
  const cloudflare = isRecord(config.cloudflare) ? config.cloudflare : undefined
  const wrangler = cloudflare && isRecord(cloudflare.wrangler) ? cloudflare.wrangler : undefined
  const bindings = wrangler?.d1_databases
  if (!Array.isArray(bindings)) return
  return bindings.find((binding: unknown): binding is Record<string, unknown> => isRecord(binding)
    && binding.binding === bindingName
    && typeof binding.database_id === "string"
    && Boolean(binding.database_id.trim())
    && typeof binding.database_name === "string"
    && Boolean(binding.database_name.trim())
    && (databaseName === undefined || binding.database_name === databaseName))
}

function hasNuxtContentModule(modules: unknown[] | undefined) {
  return Array.isArray(modules) && modules.some((module) => {
    const value = Array.isArray(module) ? module[0] : module
    return value === "@nuxt/content"
  })
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key]
  if (isRecord(value)) return value
  const record: Record<string, unknown> = {}
  parent[key] = record
  return record
}
