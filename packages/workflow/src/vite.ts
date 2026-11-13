import { durabilityModuleFile } from "@vite-hub/internal/durability"
import { workflowDurabilityUrl } from "./durability.ts"
import { ownModule } from "@vite-hub/internal/build/paths"
import { workflowRuntimeModule } from "./internal/runtime-modules.ts"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { resolve } from "node:path"

import { encodeProviderOutputAliases, resolveViteHubBundleDefines } from "@vite-hub/internal/build/bundle-options"
import { contributeProviderDeploymentOutput, createDefaultCloudflareOutputRoot, createDefaultVercelOutputRoot, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, getProviderOutputCatalog, getProviderRuntimeModule, getVercelRuntimePackages, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { providerOutputAliasSources, removeProviderOutputArtifactDir, retainProviderOutputAliases, retainProviderOutputSources } from "@vite-hub/internal/build/provider-output-sources"
import { collectViteHubProviderImportAliases, createNoExternalAddition, createProviderOutputEnvironmentOwner, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { normalizeHosting } from "@vite-hub/internal/hosting"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import { normalizeWorkflowOptions } from "./config.ts"
import type { DurabilityPluginMetadata } from "@vite-hub/internal/durability"
import type { OperationContributionEntry } from "@vite-hub/internal/operations"
import { inspectWorkflowDefinitions } from "./inspect.ts"
import { discoverWorkflowDevDefinitions, workflowDevGeneratedDir, workflowTestSetupFile, writeWorkflowDevRegistryFiles } from "./internal/dev-registry.ts"
import { writeWorkflowTypes } from "./internal/registry-types.ts"
import { createCloudflareWorkflowNitroConfig, createOptionalViteDevtoolsPlugin, createVercelWorkflowTransformPlugin, discoverWorkflowProviderSources, generateWorkflowProviderOutputs, hasVercelNativeWorkflowEntry, resolveVercelWorkflowWorld, resolveWorkflowProviderOutputs, workflowPackageName, writeProviderEntries } from "./internal/vite-build.ts"

import type { AgentWorkflowModules } from "./internal/vite-build.ts"
import type { ResolvedWorkflowOptions, WorkflowOptions } from "./types.ts"
import type { ProviderDeploymentOutputGeneration, ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { Plugin as EsbuildPlugin } from "esbuild"
import type { ProviderOutputEnvironmentOwner, ViteHubProviderImportContributor } from "@vite-hub/internal/build/vite"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, ResolvedConfig, UserConfig } from "vite"
import { workflowErrorDiagnostics } from "./error-diagnostics.ts"

export { discoverWorkflowDefinitions } from "./discovery.ts"
export { createWorkflowTypes } from "./internal/registry-types.ts"
export { inspectWorkflowDefinitions, type WorkflowInspectionOptions, workflowConsoleSection } from "./inspect.ts"

interface WorkflowNitroConfigOptions {
  nitro: Record<string, unknown>
  projectRoot: string
  serverDirs?: string[]
  transformRegistry?: (code: string, id: string) => string | Promise<string>
  viteConfig?: UserConfig
}

/** Other owners write Workflow runtime paths into their generated code with this. */
export { workflowRuntimeModule }

export type WorkflowVitePlugin = Plugin & Partial<Pick<ProviderOutputEnvironmentOwner, "nitro">> & {
  vitehub?: ViteHubInspectionPluginMetadata & DurabilityPluginMetadata & {
    operations?: readonly OperationContributionEntry[]
    workflow?: {
      createNitroConfig?: (options: WorkflowNitroConfigOptions) => Promise<Record<string, unknown>>
      prepareScheduleRuntime?: (artifactDir?: string, config?: ResolvedConfig) => Promise<{
        bundleAlias: Record<string, string>
        bundlePlugins?: EsbuildPlugin[]
        native: boolean
        registryFile: string
        runtimeModules: { state: string, vercelVite: string }
      } | undefined>
    }
  }
}

interface AgentWorkflowRegistryPlugin extends Plugin {
  vitehub?: {
    agent?: {
      transformWorkflowRegistry?: (code: string, id: string) => string | Promise<string>
      /** The Agent files that the generated registry imports by path. */
      workflowModules?: AgentWorkflowModules
    }
  }
}

/** The Agent plugin hands out the paths of its files, so the registry of Agent Workflows needs no Agent package export. */
function agentWorkflowModules(plugins: unknown): AgentWorkflowModules | undefined {
  for (const plugin of [plugins].flat(Infinity)) {
    // SAFETY: Vite plugin objects may expose ViteHub's optional agent extension, which this reads defensively.
    const modules = (plugin as AgentWorkflowRegistryPlugin | null | undefined)?.vitehub?.agent?.workflowModules
    if (modules) return modules
  }
}

const noExternalAddition = createNoExternalAddition(workflowPackageName)
const workflowBuildAssociation = Symbol("vitehubWorkflowBuildAssociation")
const workflowEnvironmentAssociation = Symbol("vitehubWorkflowEnvironmentAssociation")

interface ScheduledWorkflowBuildConfig {
  config: ResolvedConfig
  providerOutput: ProviderOutputCatalog | undefined
  workflow: WorkflowOptions | undefined
  serverDirs: string[] | undefined
  environmentNames: Set<string>
  environmentAssociation?: object
}

interface InternalWorkflowModuleOptions {
  /** The module that exports `getPostgresConnectionUrl()`. Default `@vite-hub/database`. */
  databaseImport?: string
  hosting?: string
  implicitlyEnabled?: boolean
  importBase?: string
  providerImportAliases?: Record<string, string>
  /**
   * The app that the Workflow Provider Output serves next to the Workflows. `true` finds `src/server.ts` or
   * `src/worker.ts`, a file name such as `"server-workflow.ts"` picks that file in `src`, and `false` serves no app.
   */
  includeUserAppEntry?: boolean | string
  workspaceDependencyRuntimeImports?: {
    sandboxTask?: string
    sandboxTaskRuntimeState?: string
    shellWorkspace?: string
  }
  workspaceRuntimeModule?: string
}

function resolveStringAliases(config: ResolvedConfig): Record<string, string> {
  return encodeProviderOutputAliases(config.resolve.alias)
}

const databaseVitePluginName = "@vite-hub/database/vite"

/** The part of the Database Vite plugin that Workflow reads: its resolved configuration. */
interface DatabaseVitePlugin {
  api?: { getConfig?: () => { databases: Record<string, { dialect?: string } | undefined> } | undefined }
}

function findDatabasePlugin(plugins: readonly unknown[] | undefined): DatabaseVitePlugin | undefined {
  for (const plugin of plugins ?? []) {
    if (Array.isArray(plugin)) {
      const found = findDatabasePlugin(plugin)
      if (found) return found
    }
    // SAFETY: The plugin name identifies the Database integration, whose `api` has this shape.
    else if (plugin && typeof plugin === "object" && "name" in plugin && plugin.name === databaseVitePluginName) return plugin as DatabaseVitePlugin
  }
  return undefined
}

/**
 * Whether the Database integration resolved the Default Database on Postgres, with its layers, contributions, and
 * server directories. OpenWorkflow then keeps its runs there. `undefined` while the Database is not resolved yet.
 */
function readPostgresDefaultDatabase(plugin: DatabaseVitePlugin | undefined): boolean | undefined {
  if (!plugin) return false
  const config = plugin.api?.getConfig?.()
  return config ? config.databases.default?.dialect === "postgresql" : undefined
}

export function hubWorkflow(options?: WorkflowOptions, internalOptions: InternalWorkflowModuleOptions = {}): WorkflowVitePlugin {
  let providerOutput: ProviderOutputCatalog | undefined
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  const providerOutputEnvironment = createProviderOutputEnvironmentOwner("@vite-hub/workflow/vite")
  let resolved: ResolvedConfig | undefined
  const workflow: WorkflowOptions | undefined = internalOptions.implicitlyEnabled
    && normalizeHosting(internalOptions.hosting).includes("netlify")
    ? false
    : options
  const scheduleBuildConfigs = new WeakMap<ResolvedConfig, {
    config: ResolvedConfig
    providerOutput: ProviderOutputCatalog | undefined
    workflow: WorkflowOptions | undefined
    serverDirs: string[] | undefined
    environmentNames: Set<string>
    environmentAssociation?: object
  }>()
  const scheduledBuildConfigsByRoot = new Map<string, ScheduledWorkflowBuildConfig[]>()
  const buildConfigs = new WeakMap<object, {
    config: ResolvedConfig
    providerOutput: ProviderOutputCatalog | undefined
    serverDirs: string[] | undefined
    workflow: WorkflowOptions | undefined
  }>()
  let serverDirs: string[] | undefined
  const stagedArtifactDirs = new WeakMap<object, string>()
  const rejectedBuilds = new WeakSet<object>()
  const fallbackEnvironment = {}
  const buildEnvironment = (context: { environment?: object } | undefined): object =>
    context?.environment ?? context ?? fallbackEnvironment
  const shouldSkipProviderOutputEnvironment = (context: { environment?: { name?: string, config?: ResolvedConfig } } | undefined): boolean => {
    const environmentName = context?.environment?.name
    const config = context?.environment?.config ?? resolved
    const viteHubNitroContext = config && Reflect.get(config, VITEHUB_NITRO_CONFIG_CONTEXT) === true
    const ownerEnvironment = config?.environments?.nitro ? "nitro" : "ssr"
    return Boolean(environmentName && environmentName !== ownerEnvironment && viteHubNitroContext) || providerOutputEnvironment.defers(context)
  }

  function scheduledBuildConfig(config: ResolvedConfig, environmentName?: string): ScheduledWorkflowBuildConfig | undefined {
    const direct = scheduleBuildConfigs.get(config)
    if (direct) return direct
    const candidates = scheduledBuildConfigsByRoot.get(config.root) ?? []
    const catalog = getProviderOutputCatalog(config)
    // SAFETY: configResolved installs this private token on build options so Vite clones retain their owner.
    const association = config.build && (config.build as typeof config.build & { [workflowBuildAssociation]?: object })[workflowBuildAssociation]
    // SAFETY: configResolved installs this private token on Vite environment config objects.
    const environmentAssociation = (config as typeof config & { [workflowEnvironmentAssociation]?: object })[workflowEnvironmentAssociation]
    const publicDefine = JSON.stringify({
      publicUrl: config.define?.__VITEHUB_PUBLIC_URL__,
      base: config.define?.__VITEHUB_APP_BASE_URL__,
    })
    const matches = candidates.filter(candidate => {
      if (environmentAssociation && candidate.environmentAssociation === environmentAssociation) return true
      if (environmentName && candidate.environmentNames.size > 0 && !candidate.environmentNames.has(environmentName)) return false
      // SAFETY: buildStart exposes the resolved environment options object, which is the same object held by the owning config.
      if (environmentName && (candidate.config.environments?.[environmentName] as unknown) === (config as unknown)) return true
      if (catalog && candidate.providerOutput !== catalog) return false
      if (candidate.config.build.outDir !== config.build.outDir) return false
      const candidatePublicDefine = JSON.stringify({
        publicUrl: candidate.config.define?.__VITEHUB_PUBLIC_URL__,
        base: candidate.config.define?.__VITEHUB_APP_BASE_URL__,
      })
      if (candidatePublicDefine !== publicDefine) return false
      if (!association) return candidate.config.build === config.build
      // SAFETY: configResolved installs this private token on registered build options.
      return (candidate.config.build as typeof candidate.config.build & { [workflowBuildAssociation]?: object })[workflowBuildAssociation] === association
    })
    if (matches.length !== 1) throw workflowErrorDiagnostics.WORKFLOW_B0002({ root: config.root })
    const match = matches[0]!
    scheduleBuildConfigs.set(config, match)
    return match
  }

  function providerRuntimeImportAliases(provider: "cloudflare" | "vercel", generation?: ProviderDeploymentOutputGeneration, catalog = providerOutput): Record<string, string> {
    const database = getProviderRuntimeModule(catalog, "database", provider, generation)
    const blob = getProviderRuntimeModule(catalog, "blob", provider, generation)
    return {
      ...(database ? { "@vite-hub/database/runtime/registry": database } : {}),
      ...(blob ? { "@vite-hub/blob": blob } : {}),
    }
  }

  async function providerImportAliases(config = resolved): Promise<Record<string, string>> {
    if (!config) return { ...internalOptions?.providerImportAliases }
    const contributedAliases = await collectViteHubProviderImportAliases(config.plugins as Array<Plugin & ViteHubProviderImportContributor>)
    return {
      ...resolveStringAliases(config),
      ...contributedAliases,
      ...internalOptions?.providerImportAliases,
    }
  }

  async function prepareScheduleRuntime(artifactDir?: string, config = resolved) {
    if (!config) throw workflowErrorDiagnostics.WORKFLOW_B0001({ message: "[vitehub] Workflow runtime preparation requires resolved Vite config." })
    const build = scheduledBuildConfig(config)
    const workflowOptions = build?.workflow ?? workflow
    if (normalizeWorkflowOptions(workflowOptions, { hosting: internalOptions?.hosting ?? "vercel" })?.provider !== "vercel") return
    const rootDir = resolveViteHubProjectRoot(config.root)
    const aliases = await providerImportAliases(config)
    // SAFETY: The framework adds optional forwarded server directories to the active Vite configuration.
    const workflowServerDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? build?.serverDirs
    const providerSources = discoverWorkflowProviderSources(config.root, workflowServerDirs)
    const retainedSources = artifactDir
      ? await retainProviderOutputSources({
          artifactDir: resolve(artifactDir, "sources"),
          paths: [
            ...providerOutputAliasSources(aliases, [config.root]),
            ...providerSources.paths,
          ],
          roots: [config.root],
        })
      : undefined
    const definitionRootDir = retainedSources?.resolve(config.root) ?? config.root
    const retainedServerDirs = workflowServerDirs?.map(directory => retainedSources?.resolve(directory) ?? directory)
    const retainedAgentInstructions = new Map([...providerSources.agentInstructions]
      .map(([handler, instructions]) => [retainedSources?.resolve(handler) ?? handler, instructions]))
    const artifacts = await writeProviderEntries(rootDir, workflowOptions, {
      agent: agentWorkflowModules(config.plugins),
      workflow: internalOptions?.importBase,
      workspaceRuntime: internalOptions?.workspaceRuntimeModule,
      workspaceDependencies: internalOptions?.workspaceDependencyRuntimeImports,
    }, retainedServerDirs, internalOptions?.includeUserAppEntry, (config.plugins as AgentWorkflowRegistryPlugin[])
      .find(plugin => plugin.vitehub?.agent?.transformWorkflowRegistry)
      ?.vitehub?.agent?.transformWorkflowRegistry, definitionRootDir, artifactDir ? resolve(artifactDir, "output") : undefined, retainedAgentInstructions)
    const retainedAliases = retainedSources ? retainProviderOutputAliases(aliases, retainedSources) : aliases
    const native = hasVercelNativeWorkflowEntry(rootDir, artifacts.providerDefinitions, retainedAliases, artifacts.vercelNativeFiles)
    const workflowRequire = native ? createRequire(import.meta.url) : undefined
    const workflowApi = workflowRequire?.resolve("workflow/api")
    return {
      bundleAlias: {
        ...retainedAliases,
        ...(workflowApi && workflowRequire
          ? {
              "@workflow/core/runtime/world-target": resolveVercelWorkflowWorld(workflowApi),
              "workflow/api": workflowApi,
              "workflow/runtime": workflowRequire.resolve("workflow/runtime"),
            }
          : {}),
      },
      bundlePlugins: [
        createOptionalViteDevtoolsPlugin(rootDir),
        ...(native ? [await createVercelWorkflowTransformPlugin(rootDir)] : []),
      ].filter((plugin): plugin is EsbuildPlugin => Boolean(plugin)),
      native,
      registryFile: artifacts.registryFile,
      runtimeModules: { state: workflowRuntimeModule("state"), vercelVite: workflowRuntimeModule("vercel-vite") },
    }
  }

  // Provider servers install the discovered Workflow registry in production.
  // In `vite dev`, and in builds for hosts without a Provider Output server
  // (Node, Docker), a generated Nitro plugin installs it and the resolved
  // runtime configuration.
  function buildNeedsStartupRegistry(): boolean {
    if (!internalOptions.hosting) return false
    const outputs = resolveWorkflowProviderOutputs(workflow, internalOptions.hosting)
    return !outputs.cloudflare && !outputs.vercel
  }

  let devRootDir: string | undefined
  let databasePlugin: DatabaseVitePlugin | undefined
  let postgresDatabaseImport: string | undefined

  /** The Workflow configuration that the startup plugin installs: a build installs it only without a Provider Output server. */
  function startupWorkflow(): false | ResolvedWorkflowOptions | undefined {
    return startupBuild
      ? devWorkflow && buildNeedsStartupRegistry() ? devWorkflow : undefined
      : devWorkflow ?? false
  }

  function postgresDatabaseImportFor(postgres: boolean | undefined): string | undefined {
    return devWorkflow?.provider === "openworkflow" && postgres ? internalOptions.databaseImport ?? "@vite-hub/database" : undefined
  }
  let devStartupPlugin: string | undefined
  let devWorkflow: ResolvedWorkflowOptions | undefined
  let startupBuild = false

  function resolveDevWorkflow(): ResolvedWorkflowOptions | undefined {
    try {
      return normalizeWorkflowOptions(workflow, { hosting: internalOptions.hosting ?? "vercel" })
    }
    catch {
      // The build reports configuration errors. Development keeps the app running without a registry.
      return undefined
    }
  }

  async function writeDevRegistry(rootDir: string, workflow: false | ResolvedWorkflowOptions | undefined) {
    return await writeWorkflowDevRegistryFiles({
      databaseImport: postgresDatabaseImport,
      definitions: workflow ? discoverWorkflowDevDefinitions(rootDir, serverDirs) : [],
      dev: !startupBuild,
      importBase: internalOptions.importBase,
      projectRoot: rootDir,
      pluginPath: devStartupPlugin,
      workflow,
    })
  }


  return {
    name: "@vite-hub/workflow/vite",
    // Nuxt replays plugins by enforcement order; reserve this before its runtime bootstraps too.
    enforce: "pre",
    config: {
      // Nitro reads `config.nitro` in its own `config` hook, so the plugin must be added first.
      order: "pre",
      async handler(config, env) {
        // SAFETY: ViteHub supplies this optional string-array extension during framework configuration.
        serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
        // Keep forwarded directories on each config for reused build plugins.
        // SAFETY: This private fallback field is written before Vite resolves the config.
        const buildConfig = config as typeof config & { __vitehubWorkflowServerDirs?: string[] }
        buildConfig.__vitehubWorkflowServerDirs = serverDirs
        devWorkflow = resolveDevWorkflow()
        startupBuild = env.command === "build"
        if (startupBuild && !internalOptions.hosting) return
        const projectRoot = Reflect.get(config, VITEHUB_PROJECT_ROOT)
        devRootDir = resolveViteHubProjectRoot(resolve(config.root || process.cwd()), { projectRoot: typeof projectRoot === "string" ? projectRoot : undefined })
        // Reserve the startup plugin before Nitro reads config. Later hooks may enable Workflows.
        const { plugin } = await writeDevRegistry(devRootDir, startupBuild ? undefined : devWorkflow ?? false)
        devStartupPlugin = plugin
        const kit = createNitroServerKit(Reflect.get(config, "nitro"))
        kit.addPlugin(plugin, "start")
        Reflect.set(config, "nitro", kit.config)
        if (process.env.VITEST) {
          const testConfig: UserConfig & { test: { setupFiles: string[] } } = {
            test: { setupFiles: [resolve(devRootDir, workflowDevGeneratedDir, workflowTestSetupFile)] },
          }
          return testConfig
        }
      },
    },
    configureServer(server) {
      const rootDir = devRootDir
      const workflowConfig = devWorkflow
      if (!rootDir || !workflowConfig) return
      const watchedDirectories = (serverDirs ?? [resolve(rootDir, "server")]).map(directory => resolve(rootDir, directory))
      server.watcher.add([...watchedDirectories, rootDir])
      // Vite does not call `handleHotUpdate` for new or deleted files, so watch them directly.
      const refresh = async (path: string) => {
        const file = path.replace(/\\/g, "/")
        if (file.includes(`/${workflowDevGeneratedDir}/`)) return
        const environment = server.environments.nitro ?? server.environments.ssr
        const registryPath = resolve(rootDir, workflowDevGeneratedDir, "dev-registry.mjs").replace(/\\/g, "/")
        const modules = [...(environment?.moduleGraph.getModulesByFile(file) ?? [])]
        const visited = new Set<typeof modules[number]>()
        let registryDependency = false
        while (modules.length) {
          const module = modules.pop()
          if (!module) continue
          if (visited.has(module)) continue
          visited.add(module)
          if (module.file?.replace(/\\/g, "/") === registryPath) {
            registryDependency = true
            break
          }
          modules.push(...module.importers)
        }
        const definitionFile = /\.(?:c|m)?[jt]s$/i.test(file) && /(?:\/workflows\/|\.workflow\.)/i.test(file)
        if (!definitionFile && !registryDependency) return
        const { changed } = await writeDevRegistry(rootDir, workflowConfig)
        await writeWorkflowTypes(rootDir, discoverWorkflowDevDefinitions(rootDir, serverDirs), internalOptions.importBase)
        const filesToInvalidate = new Set([
          ...changed,
          resolve(rootDir, workflowDevGeneratedDir, "dev-registry.mjs"),
        ].map(file => file.replace(/\\/g, "/")))
        let invalidated = false
        for (const changedFile of filesToInvalidate) {
          for (const module of environment?.moduleGraph.getModulesByFile(changedFile) ?? []) {
            environment.moduleGraph.invalidateModule(module)
            invalidated = true
          }
        }
        if (invalidated) environment?.hot.send({ type: "full-reload", triggeredBy: path })
      }
      let pendingRefresh = Promise.resolve()
      for (const event of ["add", "change", "unlink"] as const) {
        server.watcher.on(event, path => {
          pendingRefresh = pendingRefresh.then(() => refresh(path)).catch(error => {
            server.config.logger.error(`[vitehub] Workflow dev registry update failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        })
      }
    },
    async configResolved(config) {
      resolved = config
      providerOutput = useProviderOutputCatalog(config)
      // SAFETY: The framework adds optional forwarded server directories to resolved Vite configuration.
      const buildConfig = config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[], __vitehubWorkflowServerDirs?: string[] }
      // Vite clones environment configs by copying the build options. Keep a
      // stable owner token on that object so clones retain their full
      // Workflow and Provider Output association.
      // SAFETY: This plugin owns the private association token on resolved build options.
      const buildWithAssociation = config.build as typeof config.build & { [workflowBuildAssociation]?: object }
      if (buildWithAssociation && !buildWithAssociation[workflowBuildAssociation]) {
        Object.defineProperty(buildWithAssociation, workflowBuildAssociation, {
          configurable: false,
          enumerable: true,
          value: {},
          writable: false,
        })
      }
      const environmentAssociation = {}
      for (const environment of Object.values(config.environments ?? {})) {
        Object.defineProperty(environment, workflowEnvironmentAssociation, {
          configurable: false,
          enumerable: false,
          value: environmentAssociation,
          writable: false,
        })
      }
      const buildServerDirs = buildConfig[VITEHUB_SERVER_DIRS] ?? buildConfig.__vitehubWorkflowServerDirs
      serverDirs = buildServerDirs
      const scheduled = { config, providerOutput, workflow, serverDirs: buildServerDirs, environmentNames: new Set<string>(), environmentAssociation }
      scheduleBuildConfigs.set(config, scheduled)
      const configs = (scheduledBuildConfigsByRoot.get(config.root) ?? []).filter(previous => previous.config !== config)
      configs.push(scheduled)
      scheduledBuildConfigsByRoot.set(config.root, configs)
      if (devRootDir) {
        const projectRoot = Reflect.get(config, VITEHUB_PROJECT_ROOT)
        devRootDir = resolveViteHubProjectRoot(config.root, { projectRoot: typeof projectRoot === "string" ? projectRoot : undefined })
        devWorkflow = resolveDevWorkflow()
        databasePlugin = findDatabasePlugin(config.plugins)
        postgresDatabaseImport = postgresDatabaseImportFor(readPostgresDefaultDatabase(databasePlugin))
        await writeDevRegistry(devRootDir, startupWorkflow())
      }
      const typesRoot = devRootDir ?? resolveViteHubProjectRoot(config.root)
      await writeWorkflowTypes(typesRoot, workflow === false ? [] : discoverWorkflowDevDefinitions(typesRoot, buildServerDirs), internalOptions.importBase)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }
      return {
        resolve: { noExternal: noExternalAddition(config.resolve?.noExternal) },
      }
    },
    vitehub: {
      durability: () => {
        const options = normalizeWorkflowOptions(workflow, { hosting: internalOptions?.hosting ?? "vercel" })
        if (!options) return []
        const input = {
          provider: options.provider,
          defaultDatabase: options.provider === "openworkflow" && readPostgresDefaultDatabase(databasePlugin) === true,
          ...(options.provider === "openworkflow" && options.postgres?.url !== undefined ? { postgresUrl: workflowDurabilityUrl(options.postgres.url) } : {}),
          ...(options.provider === "openworkflow" && options.sqlite?.path !== undefined ? { sqlitePath: options.sqlite.path } : {}),
        }
        return [{ export: "workflowDurability", input, module: durabilityModuleFile(import.meta.url), primitive: "workflow" }]
      },
      // The Console, `vitehub workflow`, and agents run these. The app imports them through `vite-hub`.
      operations: [{ export: "workflowOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).workflowOperations, module: ownModule(import.meta.url, "operations") }],
      inspect: () => {
        const options = normalizeWorkflowOptions(workflow, { hosting: internalOptions?.hosting ?? "vercel" })
        const outputs = resolveWorkflowProviderOutputs(workflow, internalOptions?.hosting ?? "vercel")
        return {
          definitions: options ? [{
            kind: "workflow",
            label: "Workflows",
            list: () => {
              const rootDir = resolved?.root ?? process.cwd()
              return inspectWorkflowDefinitions({ projectRoot: resolveViteHubProjectRoot(rootDir), rootDir, serverDirs })
            },
          }] : [],
          providerOutput: (() => {
          const rootDir = resolveViteHubProjectRoot(resolved?.root ?? process.cwd())
          const nitro = Reflect.get(resolved ?? {}, "nitro") as { rollupConfig?: { plugins?: Array<{ name?: string }> } } | undefined
          const cloudflareInNitro = nitro?.rollupConfig?.plugins?.some(plugin => plugin?.name === "vitehub-workflow-cloudflare-exports") ?? false
          if (outputs.cloudflare && cloudflareInNitro) return [{ description: "Cloudflare Workflow bindings in Nitro's Wrangler config", owner: "workflow", path: resolve(createDefaultCloudflareOutputRoot(rootDir), "wrangler.json") }]
          if (outputs.cloudflare) return [{ description: "Generated Cloudflare Workflow worker", owner: "workflow", path: resolve(createDefaultCloudflareOutputRoot(rootDir), "worker.mjs") }]
          if (outputs.vercel) return [{ description: "Generated Vercel Workflow function", owner: "workflow", path: resolve(createDefaultVercelOutputRoot(rootDir), "functions", resolveNitroVercelFunctionName(resolved ?? {}, "workflow") ?? "__server.func", "index.mjs") }]
          return []
          })(),
        }
      },
      workflow: {
        async createNitroConfig({ nitro, projectRoot, serverDirs: nitroServerDirs, transformRegistry, viteConfig }: WorkflowNitroConfigOptions) {
          if (viteConfig && (Reflect.get(viteConfig, VITEHUB_NITRO_CONFIG_CONTEXT) === true || !normalizeHosting(internalOptions.hosting).includes("cloudflare"))) return nitro
          const input = viteConfig ? { ...nitro, preset: nitro.preset ?? internalOptions.hosting } : nitro
          const configured = await createCloudflareWorkflowNitroConfig({
            agentModules: agentWorkflowModules(viteConfig?.plugins),
            nitro: input,
            rootDir: projectRoot,
            serverDirs: nitroServerDirs,
            includeUserAppEntry: internalOptions?.includeUserAppEntry,
            workflow,
            workflowImportBase: internalOptions?.importBase,
            workspaceDependencyRuntimeImports: internalOptions?.workspaceDependencyRuntimeImports,
            workspaceRuntimeModule: internalOptions?.workspaceRuntimeModule,
            transformRegistry,
          })
          if (configured === input) return nitro
          if (viteConfig && nitro.preset === undefined) delete configured.preset
          return configured
        },
        prepareScheduleRuntime,
      },
    },
    buildApp: providerOutputEnvironment.buildApp,
    nitro: providerOutputEnvironment.nitro,
    async buildStart() {
      // The Database integration can resolve its Definitions after this plugin wrote the startup plugin. Read them again,
      // and write the startup plugin again when the Default Database moved to or from Postgres.
      if (devRootDir) {
        const postgres = readPostgresDefaultDatabase(databasePlugin)
        const next = postgres === undefined ? postgresDatabaseImport : postgresDatabaseImportFor(postgres)
        if (next !== postgresDatabaseImport) {
          postgresDatabaseImport = next
          await writeDevRegistry(devRootDir, startupWorkflow())
        }
      }
      if (shouldSkipProviderOutputEnvironment(this)) return
      const context = buildEnvironment(this)
      rejectedBuilds.delete(context)
      // Vite's builder can resolve several environments before starting any of
      // them. Read the environment config here so a reused plugin does not use
      // the last configResolved call for every build.
      const environmentConfig = this?.environment?.config
      if (environmentConfig) {
        // SAFETY: This private fallback field is copied from the plugin's config hook by Vite.
        // Vite exposes the resolved environment options here, which are the same object stored in the owning resolved config's environments map.
        // SAFETY: Vite exposes the resolved environment configuration through this hook.
        const config = environmentConfig as ResolvedConfig & { [VITEHUB_SERVER_DIRS]?: string[], __vitehubWorkflowServerDirs?: string[] }
        let scheduled = scheduleBuildConfigs.get(config)
        try {
          scheduled ??= scheduledBuildConfig(config, this.environment?.name)
        } catch (error) {
          rejectedBuilds.add(context)
          throw error
        }
        scheduled ??= {
          config,
          providerOutput: useProviderOutputCatalog(config),
          serverDirs: config[VITEHUB_SERVER_DIRS] ?? config.__vitehubWorkflowServerDirs,
          workflow,
          environmentNames: new Set<string>(),
        }
        if (this.environment?.name) scheduled.environmentNames.add(this.environment.name)
        buildConfigs.set(context, {
          config: environmentConfig,
          providerOutput: scheduled.providerOutput,
          serverDirs: scheduled.serverDirs,
          workflow: scheduled.workflow,
        })
      }
      else if (resolved) {
        buildConfigs.set(context, { config: resolved, providerOutput, serverDirs, workflow })
      }
      providerOutputGenerations.capture(this, buildConfigs.get(context)?.providerOutput ?? providerOutput)
    },
    async buildEnd(error) {
      if (rejectedBuilds.has(buildEnvironment(this)) || shouldSkipProviderOutputEnvironment(this)) return
      const build = buildConfigs.get(buildEnvironment(this))
      if (error) {
        await providerOutputGenerations.reset(this, build?.providerOutput ?? providerOutput, error)
        return
      }
      const config = build?.config ?? resolved
      const buildProviderOutput = build?.providerOutput ?? providerOutput
      if (!config || shouldSkipViteProviderBuild(config.command)) {
        return
      }
      const rootDir = resolveViteHubProjectRoot(config.root)
      // SAFETY: Vite plugin objects may expose ViteHub's optional agent extension, which the predicate reads defensively.
      const plugins = config.plugins as AgentWorkflowRegistryPlugin[]
      const generation = providerOutputGenerations.get(this)
      const environment = generation ?? buildEnvironment(this)
      const artifactDir = resolve(rootDir, ".vitehub/workflow-generations", randomUUID())
      const workflowOptions = build ? build.workflow : workflow
      const workflowServerDirs = build ? build.serverDirs : serverDirs
      const transformRegistry = plugins
        .find(plugin => plugin.vitehub?.agent?.transformWorkflowRegistry)
        ?.vitehub?.agent?.transformWorkflowRegistry
      try {
        const importAliases = await providerImportAliases(config)
        const runtimeImportAliases = {
          cloudflare: providerRuntimeImportAliases("cloudflare", generation, buildProviderOutput),
          vercel: providerRuntimeImportAliases("vercel", generation, buildProviderOutput),
        }
        const providerSources = discoverWorkflowProviderSources(config.root, workflowServerDirs)
        const outputs = resolveWorkflowProviderOutputs(workflowOptions, internalOptions?.hosting)
        // Read this build's Nitro output instead of retaining an early provider decision across builds.
        // SAFETY: createNitroConfig installs the named Rollup plugin when Nitro owns the Workflow classes.
        const nitro = Reflect.get(config, "nitro") as { rollupConfig?: { plugins?: Array<{ name?: string }> } } | undefined
        const cloudflareInNitro = nitro?.rollupConfig?.plugins?.some(plugin => plugin?.name === "vitehub-workflow-cloudflare-exports") ?? false
        // Only Provider Output bundles read retained sources, and a snapshot of every alias root is slow in large apps.
        const retainedSources = !outputs.cloudflare && !outputs.vercel ? { resolve: (path: string) => path } : await retainProviderOutputSources({
          artifactDir: resolve(artifactDir, "sources"),
          paths: [
            ...providerOutputAliasSources(importAliases, [config.root]),
            ...providerOutputAliasSources(runtimeImportAliases.cloudflare, [config.root]),
            ...providerOutputAliasSources(runtimeImportAliases.vercel, [config.root]),
            ...providerSources.paths,
          ],
          roots: [config.root],
        })
        const retainedImportAliases = retainProviderOutputAliases(importAliases, retainedSources)
        const retainedRuntimeImportAliases = {
          cloudflare: retainProviderOutputAliases(runtimeImportAliases.cloudflare, retainedSources),
          vercel: retainProviderOutputAliases(runtimeImportAliases.vercel, retainedSources),
        }
        const retainedDefinitionRoot = retainedSources.resolve(config.root)
        const retainedServerDirs = workflowServerDirs?.map(directory => retainedSources.resolve(directory))
        const retainedAgentInstructions = new Map([...providerSources.agentInstructions]
          .map(([handler, instructions]) => [retainedSources.resolve(handler), instructions]))
        const artifacts = await writeProviderEntries(rootDir, workflowOptions, {
          agent: agentWorkflowModules(config.plugins),
          workflow: internalOptions?.importBase,
          workspaceRuntime: internalOptions?.workspaceRuntimeModule,
          workspaceDependencies: internalOptions?.workspaceDependencyRuntimeImports,
        }, retainedServerDirs, internalOptions?.includeUserAppEntry, transformRegistry, retainedDefinitionRoot, resolve(artifactDir, "output"), retainedAgentInstructions)
        stagedArtifactDirs.set(environment, artifactDir)
        contributeProviderDeploymentOutput(buildProviderOutput, {
          discard: async () => {
            await removeProviderOutputArtifactDir(artifactDir)
            if (stagedArtifactDirs.get(environment) === artifactDir) stagedArtifactDirs.delete(environment)
          },
          owner: "workflow",
          rootDir,
          write: async ({ write }) => {
            await generateWorkflowProviderOutputs({
              agentModules: agentWorkflowModules(config.plugins),
              artifacts,
              clientOutDir: resolve(config.root, config.build.outDir),
              bundleDefines: resolveViteHubBundleDefines(config),
              cloudflareInNitro,
              hosting: internalOptions?.hosting,
              importBase: internalOptions?.importBase,
              providerImportAliases: retainedImportAliases,
              providerRuntimeImportAliases: retainedRuntimeImportAliases,
              vercelRuntimePackages: getVercelRuntimePackages(buildProviderOutput, "blob", generation),
              rootDir,
              definitionRootDir: retainedDefinitionRoot,
              serverDirs: retainedServerDirs,
              serverFunctionName: resolveNitroVercelFunctionName(config, "workflow"),
              sourceRootDir: retainedSources.resolve(rootDir),
              includeUserAppEntry: internalOptions?.includeUserAppEntry,
              workflow: workflowOptions,
              workspaceDependencyRuntimeImports: internalOptions?.workspaceDependencyRuntimeImports,
              workspaceRuntimeModule: internalOptions?.workspaceRuntimeModule,
              transformRegistry,
            }, write)
          },
        }, generation)
      }
      catch (error) {
        await removeProviderOutputArtifactDir(artifactDir)
        if (stagedArtifactDirs.get(environment) === artifactDir) stagedArtifactDirs.delete(environment)
        await providerOutputGenerations.reset(this, buildProviderOutput, error)
        throw error
      }
    },
    async renderError(error) {
      if (rejectedBuilds.has(buildEnvironment(this)) || shouldSkipProviderOutputEnvironment(this)) return
      const environment = providerOutputGenerations.get(this) ?? buildEnvironment(this)
      const build = buildConfigs.get(buildEnvironment(this))
      await providerOutputGenerations.reset(this, build?.providerOutput ?? providerOutput, error)
      const artifactDir = stagedArtifactDirs.get(environment)
      if (artifactDir) {
        await removeProviderOutputArtifactDir(artifactDir)
        if (stagedArtifactDirs.get(environment) === artifactDir) stagedArtifactDirs.delete(environment)
      }
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        if (rejectedBuilds.has(buildEnvironment(this)) || shouldSkipProviderOutputEnvironment(this)) return
        const build = buildConfigs.get(buildEnvironment(this))
        const config = build?.config ?? resolved
        if (!config || shouldSkipViteProviderBuild(config.command)) return
        await finalizeProviderDeploymentOutputs(build?.providerOutput ?? providerOutput)
      },
    },
  }
}

