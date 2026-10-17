import { resolve } from "node:path"

import { createNoExternalAddition, hasNitroConfigContext, isServerEnvironment, resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { normalizeHosting } from "@vite-hub/internal/hosting"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import { normalizeWorkflowOptions } from "./config.ts"
import { registerWorkflowDevEndpoint } from "./dev-endpoint.ts"
import { workflowDevRuntimeRoute } from "./dev-support.ts"
import { writeWorkflowDevFiles } from "./internal/dev-runtime.ts"
import type { WorkflowDevGeneratedState } from "./internal/dev-runtime.ts"
import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import { inspectWorkflowDefinitions } from "./inspect.ts"
import { discoverWorkflowDevDefinitions, workflowDevGeneratedDir, writeWorkflowDevRegistryFiles } from "./internal/dev-registry.ts"
import { createWorkflowNitroConfig, workflowPackageName } from "./internal/vite-build.ts"

import type { ResolvedWorkflowOptions, WorkflowModuleOptions } from "./types.ts"
import type { WorkflowImportBases } from "./internal/vite-build.ts"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { AliasOptions, Plugin, ResolvedConfig } from "vite"

export { discoverWorkflowDefinitions } from "./discovery.ts"
export { inspectWorkflowDefinitions, type WorkflowInspectionOptions, workflowConsoleSection } from "./inspect.ts"

interface WorkflowNitroConfigOptions {
  nitro: Record<string, unknown>
  projectRoot: string
  serverDirs?: string[]
  transformRegistry?: (code: string, id: string) => string | Promise<string>
}

export type WorkflowVitePlugin = Plugin & {
  vitehub?: ViteHubInspectionPluginMetadata & ViteHubCliPluginMetadata & {
    workflow?: {
      /** Adds the Workflow registry and host output to a Nitro config that a framework owns, such as Nuxt. */
      createNitroConfig?: (options: WorkflowNitroConfigOptions) => Promise<Record<string, unknown>>
    }
  }
}

const noExternalAddition = createNoExternalAddition(workflowPackageName)

interface InternalWorkflowModuleOptions {
  agentImportBase?: string
  hosting?: string
  implicitlyEnabled?: boolean
  importBase?: string
  providerImportAliases?: Record<string, string>
  workspaceDependencyRuntimeImports?: {
    sandboxTask?: string
    sandboxTaskRuntimeState?: string
    shellWorkspace?: string
  }
  workspaceImportBase?: string
}

function stringAliases(alias: AliasOptions | undefined): Record<string, string> {
  if (!alias) return {}
  const entries = Array.isArray(alias)
    ? alias.map(entry => [entry.find, entry.replacement] as const)
    : Object.entries(alias)
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"))
}

function resolveNitroHosting(nitro: unknown, fallback: string | undefined): string | undefined {
  const preset = Reflect.get(Object(nitro), "preset")
  if (typeof preset === "string" && preset) return preset
  return process.env.NITRO_PRESET || process.env.SERVER_PRESET || fallback
}

export function hubWorkflow(options?: WorkflowModuleOptions, internalOptions: InternalWorkflowModuleOptions = {}): WorkflowVitePlugin {
  let resolved: ResolvedConfig | undefined
  const defaultWorkflow: WorkflowModuleOptions | undefined = internalOptions.implicitlyEnabled
    && normalizeHosting(internalOptions.hosting).includes("netlify")
    ? false
    : options
  let workflow = defaultWorkflow
  let serverDirs: string[] | undefined
  const importBases: WorkflowImportBases = {
    agent: internalOptions.agentImportBase,
    workflow: internalOptions.importBase,
    workspace: internalOptions.workspaceImportBase,
    workspaceDependencies: internalOptions.workspaceDependencyRuntimeImports,
  }

  function devGeneratedState(): WorkflowDevGeneratedState {
    try {
      const config = normalizeWorkflowOptions(workflow, { hosting: internalOptions.hosting ?? "vercel" })
      return { configuredProvider: config ? config.provider : null }
    }
    catch (error) {
      return { configError: error instanceof Error ? error.message : String(error), configuredProvider: null }
    }
  }

  // In `vite dev`, a generated Nitro plugin installs the registry and the resolved runtime configuration.
  // `vite build` adds the build registry and host output to the Nitro config instead.
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
        workflow = config.workflow === undefined ? defaultWorkflow : config.workflow
        // SAFETY: ViteHub supplies this optional string-array extension during framework configuration.
        serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
        const projectRoot = Reflect.get(config, VITEHUB_PROJECT_ROOT)
        const viteRoot = resolve(config.root || process.cwd())
        const rootDir = resolveViteHubProjectRoot(viteRoot, { projectRoot: typeof projectRoot === "string" ? projectRoot : undefined })
        if (env.command !== "serve") {
          // Nuxt owns its Nitro config and calls `createNitroConfig` instead.
          if (Reflect.get(config, VITEHUB_NITRO_CONFIG_CONTEXT) === true || !hasNitroConfigContext(config)) return
          const nitro = await createWorkflowNitroConfig({
            aliases: { ...stringAliases(config.resolve?.alias), ...internalOptions.providerImportAliases },
            definitionRootDir: viteRoot,
            hosting: resolveNitroHosting(Reflect.get(config, "nitro"), internalOptions.hosting),
            importBases,
            nitro: Object(Reflect.get(config, "nitro") ?? {}),
            rootDir,
            serverDirs,
            vite: true,
            workflow,
          })
          Reflect.set(config, "nitro", nitro)
          return
        }
        devWorkflow = resolveDevWorkflow()
        devRootDir = rootDir
        // Reserve the startup plugin before Nitro reads config. Later hooks may enable Workflows.
        const { plugin } = await writeDevRegistry(devRootDir, devWorkflow ?? false)
        devStartupPlugin = plugin
        const kit = createNitroServerKit(Reflect.get(config, "nitro"))
        kit.addPlugin(plugin, "start")
        const { handler } = await writeWorkflowDevFiles({ ...devGeneratedState(), importBase: internalOptions.importBase, projectRoot: devRootDir })
        kit.addHandler({ handler, route: workflowDevRuntimeRoute })
        Reflect.set(config, "nitro", kit.config)
      },
    },
    configureServer(server) {
      if (resolved?.command === "serve") {
        registerWorkflowDevEndpoint(server, {
          nitroBaseURL: () => {
            const baseURL = Reflect.get(Object(Reflect.get(resolved ?? {}, "nitro")), "baseURL")
            return typeof baseURL === "string" ? baseURL : process.env.NITRO_APP_BASE_URL
          },
        })
      }
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
      workflow = config.workflow === undefined ? defaultWorkflow : config.workflow
      // SAFETY: The framework adds optional forwarded server directories to resolved Vite configuration.
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      if (devRootDir) {
        const projectRoot = Reflect.get(config, VITEHUB_PROJECT_ROOT)
        devRootDir = resolveViteHubProjectRoot(config.root, { projectRoot: typeof projectRoot === "string" ? projectRoot : undefined })
        devWorkflow = resolveDevWorkflow()
        await writeDevRegistry(devRootDir, devWorkflow ?? false)
        await writeWorkflowDevFiles({ ...devGeneratedState(), importBase: internalOptions.importBase, projectRoot: devRootDir })
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
      cli: async () => (await import("./cli.ts")).createWorkflowCliContributor(),
      inspect: () => {
        const options = normalizeWorkflowOptions(workflow, { hosting: internalOptions.hosting ?? "vercel" })
        return {
          definitions: options ? [{
            kind: "workflow",
            label: "Workflows",
            list: () => {
              const rootDir = resolved?.root ?? process.cwd()
              return inspectWorkflowDefinitions({ projectRoot: resolveViteHubProjectRoot(rootDir), rootDir, serverDirs })
            },
          }] : [],
        }
      },
      workflow: {
        async createNitroConfig({ nitro, projectRoot, serverDirs: nitroServerDirs, transformRegistry }: WorkflowNitroConfigOptions) {
          return await createWorkflowNitroConfig({
            aliases: internalOptions.providerImportAliases,
            hosting: internalOptions.hosting,
            importBases,
            nitro,
            rootDir: projectRoot,
            serverDirs: nitroServerDirs,
            transformRegistry,
            workflow,
          })
        },
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    workflow?: WorkflowModuleOptions
  }
}
