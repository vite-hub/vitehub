import { resolveViteHubBundleDefines } from "@vite-hub/internal/build/esbuild"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { resolve } from "node:path"

import { getViteMode } from "@vite-hub/internal/build/mode"
import { encodeProviderOutputAliases } from "@vite-hub/internal/build/esbuild"
import { contributeProviderDeploymentOutput, createDefaultCloudflareOutputRoot, createDefaultVercelOutputRoot, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, getProviderOutputCatalog, getProviderRuntimeModule, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { removeProviderOutputArtifactDir, retainProviderOutputAliases, retainProviderOutputSources } from "@vite-hub/internal/build/provider-output-sources"
import { collectViteHubProviderImportAliases, createNoExternalAddition, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { normalizeHosting } from "@vite-hub/internal/hosting"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import { normalizeWorkflowOptions } from "./config.ts"
import { inspectWorkflowDefinitions } from "./inspect.ts"
import { discoverWorkflowDevDefinitions, workflowDevGeneratedDir, writeWorkflowDevRegistryFiles } from "./internal/dev-registry.ts"
import { createCloudflareWorkflowNitroConfig, createOptionalViteDevtoolsPlugin, createVercelWorkflowTransformPlugin, discoverWorkflowProviderSources, generateWorkflowProviderOutputs, hasVercelNativeWorkflowEntry, resolveVercelWorkflowWorld, workflowPackageName, writeProviderEntries } from "./internal/vite-build.ts"

import type { ResolvedWorkflowOptions, WorkflowModuleOptions } from "./types.ts"
import type { ProviderDeploymentOutputGeneration, ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { Plugin as EsbuildPlugin } from "esbuild"
import type { ViteHubProviderImportContributor } from "@vite-hub/internal/build/vite"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, ResolvedConfig } from "vite"
import { workflowErrorDiagnostics } from "./error-diagnostics.ts"

export { discoverWorkflowDefinitions } from "./discovery.ts"
export { inspectWorkflowDefinitions, type WorkflowInspectionOptions, workflowConsoleSection } from "./inspect.ts"

interface WorkflowNitroConfigOptions {
  nitro: Record<string, unknown>
  projectRoot: string
  serverDirs?: string[]
  transformRegistry?: (code: string, id: string) => string | Promise<string>
}

export type WorkflowVitePlugin = Plugin & {
  vitehub?: ViteHubInspectionPluginMetadata & {
    workflow?: {
      createNitroConfig?: (options: WorkflowNitroConfigOptions) => Promise<Record<string, unknown>>
      prepareScheduleRuntime?: (artifactDir?: string, config?: ResolvedConfig) => Promise<{
        bundleAlias: Record<string, string>
        bundlePlugins?: EsbuildPlugin[]
        importBase: string
        native: boolean
        registryFile: string
      } | undefined>
    }
  }
}

interface AgentWorkflowRegistryPlugin extends Plugin {
  vitehub?: {
    agent?: {
      transformWorkflowRegistry?: (code: string, id: string) => string | Promise<string>
    }
  }
}

const noExternalAddition = createNoExternalAddition(workflowPackageName)
const workflowBuildAssociation = Symbol("vitehubWorkflowBuildAssociation")

interface ScheduledWorkflowBuildConfig {
  config: ResolvedConfig
  providerOutput: ProviderOutputCatalog | undefined
  workflow: WorkflowModuleOptions | undefined
  serverDirs: string[] | undefined
}

interface InternalWorkflowModuleOptions {
  agentImportBase?: string
  hosting?: string
  implicitlyEnabled?: boolean
  importBase?: string
  providerImportAliases?: Record<string, string>
  includeUserAppEntry?: boolean
  workspaceDependencyRuntimeImports?: {
    sandbox?: string
    sandboxRuntimeState?: string
    shellWorkspace?: string
  }
  workspaceImportBase?: string
}

function resolveStringAliases(config: ResolvedConfig): Record<string, string> {
  return encodeProviderOutputAliases(config.resolve.alias)
}

export function hubWorkflow(options?: WorkflowModuleOptions, internalOptions: InternalWorkflowModuleOptions = {}): WorkflowVitePlugin {
  let providerOutput: ProviderOutputCatalog | undefined
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  let resolved: ResolvedConfig | undefined
  const defaultWorkflow: WorkflowModuleOptions | undefined = internalOptions.implicitlyEnabled
    && normalizeHosting(internalOptions.hosting).includes("netlify")
    ? false
    : options
  let workflow = defaultWorkflow
  const scheduleBuildConfigs = new WeakMap<ResolvedConfig, {
    config: ResolvedConfig
    providerOutput: ProviderOutputCatalog | undefined
    workflow: WorkflowModuleOptions | undefined
    serverDirs: string[] | undefined
  }>()
  const scheduledBuildConfigsByRoot = new Map<string, ScheduledWorkflowBuildConfig[]>()
  const buildConfigs = new WeakMap<object, {
    config: ResolvedConfig
    providerOutput: ProviderOutputCatalog | undefined
    serverDirs: string[] | undefined
    workflow: WorkflowModuleOptions | undefined
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
    return Boolean(environmentName && environmentName !== ownerEnvironment && viteHubNitroContext)
  }

  function scheduledBuildConfig(config: ResolvedConfig): ScheduledWorkflowBuildConfig | undefined {
    const direct = scheduleBuildConfigs.get(config)
    if (direct) return direct
    const candidates = scheduledBuildConfigsByRoot.get(config.root) ?? []
    const catalog = getProviderOutputCatalog(config)
    // SAFETY: configResolved installs this private token on build options so Vite clones retain their owner.
    const association = config.build && (config.build as typeof config.build & { [workflowBuildAssociation]?: object })[workflowBuildAssociation]
    const matches = catalog
      ? candidates.filter(candidate => candidate.providerOutput === catalog)
      : candidates.filter(candidate => candidate.config.build === config.build || (association && (
          // SAFETY: configResolved installs this private token on registered build options.
          (candidate.config.build as typeof candidate.config.build & { [workflowBuildAssociation]?: object })[workflowBuildAssociation] === association
        )))
    if (matches.length !== 1) throw workflowErrorDiagnostics.WORKFLOW_B0002({ root: config.root })
    const match = matches[0]!
    scheduleBuildConfigs.set(config, match)
    return match
  }

  function providerRuntimeImportAliases(provider: "cloudflare" | "vercel", generation?: ProviderDeploymentOutputGeneration, catalog = providerOutput): Record<string, string> {
    const database = getProviderRuntimeModule(catalog, "database", provider, generation)
    return database ? { "@vite-hub/database/drizzle": database } : {}
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
    const workflowOptions = config.workflow ?? build?.workflow ?? defaultWorkflow
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
            ...Object.keys(aliases),
            ...Object.values(aliases),
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
      agent: internalOptions?.agentImportBase,
      workflow: internalOptions?.importBase,
      workspace: internalOptions?.workspaceImportBase,
      workspaceDependencies: internalOptions?.workspaceDependencyRuntimeImports,
    }, retainedServerDirs, internalOptions?.includeUserAppEntry, (config.plugins as AgentWorkflowRegistryPlugin[])
      .find(plugin => plugin.vitehub?.agent?.transformWorkflowRegistry)
      ?.vitehub?.agent?.transformWorkflowRegistry, definitionRootDir, artifactDir ? resolve(artifactDir, "output") : undefined, retainedAgentInstructions)
    const importBase = internalOptions?.importBase ?? workflowPackageName
    const projectRequire = createRequire(resolve(config.root, "package.json"))
    const retainedAliases = retainedSources ? retainProviderOutputAliases(aliases, retainedSources) : aliases
    const native = hasVercelNativeWorkflowEntry(rootDir, artifacts.providerDefinitions, retainedAliases, artifacts.vercelNativeFiles)
    const workflowRequire = native ? createRequire(import.meta.url) : undefined
    const workflowApi = workflowRequire?.resolve("workflow/api")
    return {
      bundleAlias: {
        ...retainedAliases,
        [`${importBase}/runtime/state`]: projectRequire.resolve(`${importBase}/runtime/state`),
        [`${importBase}/runtime/vercel-vite`]: projectRequire.resolve(`${importBase}/runtime/vercel-vite`),
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
      importBase,
      native,
      registryFile: artifacts.registryFile,
    }
  }

  // Provider servers install the discovered Workflow registry in production.
  // In `vite dev`, a generated Nitro plugin installs it and the resolved runtime configuration.
  let devRootDir: string | undefined
  let devStartupPlugin: string | undefined
  let devWorkflow: ResolvedWorkflowOptions | undefined

  function resolveDevWorkflow(): ResolvedWorkflowOptions | undefined {
    try {
      return normalizeWorkflowOptions(workflow, { hosting: internalOptions.hosting ?? "vercel" })
    }
    catch {
      // The build reports configuration errors. Development keeps the app running without a registry.
      return undefined
    }
  }

  async function writeDevRegistry(rootDir: string, workflow: false | ResolvedWorkflowOptions) {
    return await writeWorkflowDevRegistryFiles({
      definitions: workflow === false ? [] : discoverWorkflowDevDefinitions(rootDir, serverDirs),
      importBase: internalOptions.importBase,
      projectRoot: rootDir,
      pluginPath: devStartupPlugin,
      workflow,
    })
  }

  return {
    name: "@vite-hub/workflow/vite",
    config: {
      // Nitro reads `config.nitro` in its own `config` hook, so the plugin must be added first.
      order: "pre",
      async handler(config, env) {
        workflow = config.workflow ?? defaultWorkflow
        // SAFETY: ViteHub supplies this optional string-array extension during framework configuration.
        serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
        // Keep forwarded directories on each config for reused build plugins.
        // SAFETY: This private fallback field is written before Vite resolves the config.
        const buildConfig = config as typeof config & { __vitehubWorkflowServerDirs?: string[] }
        buildConfig.__vitehubWorkflowServerDirs = serverDirs
        if (env.command !== "serve") return
        devWorkflow = resolveDevWorkflow()
        const projectRoot = Reflect.get(config, VITEHUB_PROJECT_ROOT)
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- ViteHub adds its authoritative project root to otherwise opaque Vite config extensions.
        devRootDir = resolveViteHubProjectRoot(resolve(config.root || process.cwd()), { projectRoot: typeof projectRoot === "string" ? projectRoot : undefined })
        // Reserve the startup plugin before Nitro reads config. Later hooks may enable Workflows.
        const { plugin } = await writeDevRegistry(devRootDir, devWorkflow ?? false)
        devStartupPlugin = plugin
        const kit = createNitroServerKit(Reflect.get(config, "nitro"))
        kit.addPlugin(plugin, "start")
        Reflect.set(config, "nitro", kit.config)
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
      workflow = config.workflow ?? defaultWorkflow
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
      const buildServerDirs = buildConfig[VITEHUB_SERVER_DIRS] ?? buildConfig.__vitehubWorkflowServerDirs
      serverDirs = buildServerDirs
      const scheduled = { config, providerOutput, workflow, serverDirs: buildServerDirs }
      scheduleBuildConfigs.set(config, scheduled)
      const configs = (scheduledBuildConfigsByRoot.get(config.root) ?? []).filter(previous => previous.config !== config)
      configs.push(scheduled)
      scheduledBuildConfigsByRoot.set(config.root, configs)
      if (devRootDir) {
        const projectRoot = Reflect.get(config, VITEHUB_PROJECT_ROOT)
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Later Vite hooks may change the authoritative project root.
        devRootDir = resolveViteHubProjectRoot(config.root, { projectRoot: typeof projectRoot === "string" ? projectRoot : undefined })
        devWorkflow = resolveDevWorkflow()
        await writeDevRegistry(devRootDir, devWorkflow ?? false)
      }
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
      inspect: () => {
        const normalized = normalizeWorkflowOptions(workflow, { hosting: internalOptions?.hosting ?? "vercel" })
        if (!normalized) return
        const rootDir = resolveViteHubProjectRoot(resolved?.root ?? process.cwd())
        return {
          definitions: [{
          kind: "workflow",
          label: "Workflows",
          list: () => {
            const rootDir = resolved?.root ?? process.cwd()
            return inspectWorkflowDefinitions({ projectRoot: resolveViteHubProjectRoot(rootDir), rootDir, serverDirs })
          },
          }],
          providerOutput: normalized.provider === "cloudflare"
            ? [{ description: "Generated Cloudflare Workflow worker", owner: "workflow", path: resolve(createDefaultCloudflareOutputRoot(rootDir), "worker.mjs") }]
            : normalized.provider === "vercel"
              ? [{ description: "Generated Vercel Workflow function", owner: "workflow", path: resolve(createDefaultVercelOutputRoot(rootDir), "functions", resolveNitroVercelFunctionName(resolved ?? {}, "workflow") ?? "__server.func", "index.mjs") }]
              : [],
        }
      },
      workflow: {
        async createNitroConfig({ nitro, projectRoot, serverDirs: nitroServerDirs, transformRegistry }: WorkflowNitroConfigOptions) {
          return await createCloudflareWorkflowNitroConfig({
            agentImportBase: internalOptions?.agentImportBase,
            nitro,
            rootDir: projectRoot,
            serverDirs: nitroServerDirs,
            includeUserAppEntry: internalOptions?.includeUserAppEntry,
            workflow,
            workflowImportBase: internalOptions?.importBase,
            workspaceDependencyRuntimeImports: internalOptions?.workspaceDependencyRuntimeImports,
            workspaceImportBase: internalOptions?.workspaceImportBase,
            transformRegistry,
          })
        },
        prepareScheduleRuntime,
      },
    },
    buildStart() {
      if (shouldSkipProviderOutputEnvironment(this)) return
      const context = buildEnvironment(this)
      rejectedBuilds.delete(context)
      // Vite's builder can resolve several environments before starting any of
      // them. Read the environment config here so a reused plugin does not use
      // the last configResolved call for every build.
      const environmentConfig = this?.environment?.config
      if (environmentConfig) {
        // SAFETY: This private fallback field is copied from the plugin's config hook by Vite.
        const config = environmentConfig as typeof environmentConfig & { [VITEHUB_SERVER_DIRS]?: string[], __vitehubWorkflowServerDirs?: string[] }
        let scheduled = scheduleBuildConfigs.get(config)
        try {
          scheduled ??= scheduledBuildConfig(config)
        } catch (error) {
          rejectedBuilds.add(context)
          throw error
        }
        scheduled ??= {
          config,
          providerOutput: useProviderOutputCatalog(config),
          serverDirs: config[VITEHUB_SERVER_DIRS] ?? config.__vitehubWorkflowServerDirs,
          workflow: config.workflow ?? defaultWorkflow,
        }
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
      if (!config || shouldSkipViteProviderBuild(config.command, getViteMode())) {
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
        const retainedSources = await retainProviderOutputSources({
          artifactDir: resolve(artifactDir, "sources"),
          paths: [
            ...Object.keys(importAliases),
            ...Object.values(importAliases),
            ...Object.keys(runtimeImportAliases.cloudflare),
            ...Object.values(runtimeImportAliases.cloudflare),
            ...Object.keys(runtimeImportAliases.vercel),
            ...Object.values(runtimeImportAliases.vercel),
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
          agent: internalOptions?.agentImportBase,
          workflow: internalOptions?.importBase,
          workspace: internalOptions?.workspaceImportBase,
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
              agentImportBase: internalOptions?.agentImportBase,
              artifacts,
              clientOutDir: resolve(config.root, config.build.outDir),
              bundleDefines: resolveViteHubBundleDefines(config),
              hosting: internalOptions?.hosting,
              importBase: internalOptions?.importBase,
              providerImportAliases: retainedImportAliases,
              providerRuntimeImportAliases: retainedRuntimeImportAliases,
              rootDir,
              definitionRootDir: retainedDefinitionRoot,
              serverDirs: retainedServerDirs,
              serverFunctionName: resolveNitroVercelFunctionName(config, "workflow"),
              sourceRootDir: retainedSources.resolve(rootDir),
              includeUserAppEntry: internalOptions?.includeUserAppEntry,
              workflow: workflowOptions,
              workspaceDependencyRuntimeImports: internalOptions?.workspaceDependencyRuntimeImports,
              workspaceImportBase: internalOptions?.workspaceImportBase,
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
        if (!config || shouldSkipViteProviderBuild(config.command, getViteMode())) return
        await finalizeProviderDeploymentOutputs(build?.providerOutput ?? providerOutput)
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    workflow?: WorkflowModuleOptions
  }
}
