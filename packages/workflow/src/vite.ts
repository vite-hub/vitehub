import { createRequire } from "node:module"
import { resolve } from "node:path"

import { getViteMode } from "@vite-hub/internal/build/mode"
import { getProviderRuntimeModule, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { collectViteHubProviderImportAliases, createNoExternalMerger, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { normalizeHosting } from "@vite-hub/internal/hosting"

import { normalizeWorkflowOptions } from "./config.ts"
import { createCloudflareWorkflowNitroConfig, createOptionalViteDevtoolsPlugin, createVercelWorkflowTransformPlugin, generateProviderOutputs, hasVercelNativeWorkflowEntry, workflowPackageName, writeProviderEntries } from "./internal/vite-build.ts"

import type { WorkflowModuleOptions } from "./types.ts"
import type { ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { Plugin as EsbuildPlugin } from "esbuild"
import type { ViteHubProviderImportContributor } from "@vite-hub/internal/build/vite"
import type { Plugin, ResolvedConfig } from "vite"

export { discoverWorkflowDefinitions } from "./discovery.ts"

interface WorkflowNitroConfigOptions {
  nitro: Record<string, unknown>
  projectRoot: string
  serverDirs?: string[]
  transformRegistry?: (code: string, id: string) => string | Promise<string>
}

export type WorkflowVitePlugin = Plugin & {
  vitehub?: {
    workflow?: {
      createNitroConfig?: (options: WorkflowNitroConfigOptions) => Promise<Record<string, unknown>>
      prepareScheduleRuntime?: () => Promise<{
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

const mergeNoExternal = createNoExternalMerger(workflowPackageName)

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
  const aliases: Record<string, string> = {}
  for (const alias of config.resolve.alias) {
    if (typeof alias.find === "string" && typeof alias.replacement === "string") {
      aliases[alias.find] = alias.replacement
    }
  }
  return aliases
}

export function hubWorkflow(options?: WorkflowModuleOptions, internalOptions: InternalWorkflowModuleOptions = {}): WorkflowVitePlugin {
  let providerOutput: ProviderOutputCatalog | undefined
  let resolved: ResolvedConfig | undefined
  let workflow: WorkflowModuleOptions | undefined = internalOptions.implicitlyEnabled
    && normalizeHosting(internalOptions.hosting).includes("netlify")
    ? false
    : options
  let serverDirs: string[] | undefined

  function providerRuntimeImportAliases(provider: "cloudflare" | "vercel"): Record<string, string> {
    const database = getProviderRuntimeModule(providerOutput, "database", provider)
    return database ? { "@vite-hub/database/drizzle": database } : {}
  }

  async function providerImportAliases(): Promise<Record<string, string>> {
    if (!resolved) return { ...internalOptions?.providerImportAliases }
    const contributedAliases = await collectViteHubProviderImportAliases(resolved.plugins as Array<Plugin & ViteHubProviderImportContributor>)
    return {
      ...resolveStringAliases(resolved),
      ...contributedAliases,
      ...internalOptions?.providerImportAliases,
    }
  }

  async function prepareScheduleRuntime() {
    if (!resolved) throw new Error("[vitehub] Workflow runtime preparation requires resolved Vite config.")
    if (normalizeWorkflowOptions(workflow, { hosting: internalOptions?.hosting ?? "vercel" })?.provider !== "vercel") return
    const rootDir = resolveViteHubProjectRoot(resolved.root)
    const artifacts = await writeProviderEntries(rootDir, workflow, {
      agent: internalOptions?.agentImportBase,
      workflow: internalOptions?.importBase,
      workspace: internalOptions?.workspaceImportBase,
      workspaceDependencies: internalOptions?.workspaceDependencyRuntimeImports,
    }, serverDirs, internalOptions?.includeUserAppEntry, (resolved.plugins as AgentWorkflowRegistryPlugin[])
      .find(plugin => plugin.vitehub?.agent?.transformWorkflowRegistry)
      ?.vitehub?.agent?.transformWorkflowRegistry, resolved.root)
    const importBase = internalOptions?.importBase ?? workflowPackageName
    const projectRequire = createRequire(resolve(resolved.root, "package.json"))
    const aliases = await providerImportAliases()
    const native = hasVercelNativeWorkflowEntry(rootDir, artifacts.providerDefinitions, aliases, artifacts.vercelNativeFiles)
    const workflowRequire = native ? createRequire(import.meta.url) : undefined
    const workflowApi = workflowRequire?.resolve("workflow/api")
    return {
      bundleAlias: {
        ...aliases,
        [`${importBase}/runtime/state`]: projectRequire.resolve(`${importBase}/runtime/state`),
        [`${importBase}/runtime/vercel-vite`]: projectRequire.resolve(`${importBase}/runtime/vercel-vite`),
        ...(workflowApi && workflowRequire
          ? {
              "@workflow/core/runtime/world-target": createRequire(workflowRequire.resolve("@workflow/builders")).resolve("@workflow/world-vercel"),
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

  return {
    name: "@vite-hub/workflow/vite",
    config(config) {
      workflow = config.workflow ?? workflow
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
    },
    configResolved(config) {
      resolved = config
      providerOutput = useProviderOutputCatalog(config)
      workflow = config.workflow ?? workflow
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    vitehub: {
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
    async closeBundle() {
      if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }
      await generateProviderOutputs({
        agentImportBase: internalOptions?.agentImportBase,
        clientOutDir: resolve(resolved.root, resolved.build.outDir),
        hosting: internalOptions?.hosting,
        importBase: internalOptions?.importBase,
        providerImportAliases: await providerImportAliases(),
        providerRuntimeImportAliases: {
          cloudflare: providerRuntimeImportAliases("cloudflare"),
          vercel: providerRuntimeImportAliases("vercel"),
        },
        rootDir: resolveViteHubProjectRoot(resolved.root),
        definitionRootDir: resolved.root,
        serverDirs,
        serverFunctionName: resolveNitroVercelFunctionName(resolved, "workflow"),
        includeUserAppEntry: internalOptions?.includeUserAppEntry,
        workflow,
        workspaceDependencyRuntimeImports: internalOptions?.workspaceDependencyRuntimeImports,
        workspaceImportBase: internalOptions?.workspaceImportBase,
        transformRegistry: (resolved.plugins as AgentWorkflowRegistryPlugin[])
          .find(plugin => plugin.vitehub?.agent?.transformWorkflowRegistry)
          ?.vitehub?.agent?.transformWorkflowRegistry,
      })
    },
  }
}

declare module "vite" {
  interface UserConfig {
    workflow?: WorkflowModuleOptions
  }
}
