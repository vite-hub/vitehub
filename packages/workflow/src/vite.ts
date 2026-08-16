import { createRequire } from "node:module"
import { resolve } from "node:path"

import { getViteMode } from "@vite-hub/internal/build/mode"
import { getProviderRuntimeModule, shouldSkipViteProviderBuild, useComposedProviderOutput } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalMerger, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { normalizeWorkflowOptions } from "./config.ts"
import { createCloudflareWorkflowNitroConfig, generateProviderOutputs, workflowPackageName, writeProviderEntries } from "./internal/vite-build.ts"

import type { WorkflowModuleOptions } from "./types.ts"
import type { ComposedProviderOutput } from "@vite-hub/internal/build/deployment-output"
import type { Plugin, ResolvedConfig } from "vite"

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
        importBase: string
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

type InternalWorkflowModuleOptions = Exclude<WorkflowModuleOptions, false> & {
  agentImportBase?: string
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

export function hubWorkflow(options?: WorkflowModuleOptions): WorkflowVitePlugin {
  const internalOptions = options as InternalWorkflowModuleOptions | undefined
  let providerOutput: ComposedProviderOutput | undefined
  let resolved: ResolvedConfig | undefined
  let workflow: WorkflowModuleOptions | undefined = options
  let serverDirs: string[] | undefined

  function providerRuntimeImportAliases(provider: "cloudflare" | "vercel"): Record<string, string> {
    const database = getProviderRuntimeModule(providerOutput, "database", provider)
    return database ? { "@vite-hub/database/drizzle": database } : {}
  }

  function providerImportAliases(): Record<string, string> {
    if (!resolved) return { ...internalOptions?.providerImportAliases }
    const aliases = {
      ...resolveStringAliases(resolved),
      ...internalOptions?.providerImportAliases,
    }
    const emailDefinition = (resolved.plugins as Array<Plugin & {
      api?: { getDefinition?: () => { handler?: string } }
    }>).find(plugin => plugin.name === "@vite-hub/email/vite")?.api?.getDefinition?.()?.handler
    if (emailDefinition) aliases["#vitehub/email/definition"] = emailDefinition
    return aliases
  }

  async function prepareScheduleRuntime() {
    if (!resolved) throw new Error("[vitehub] Workflow runtime preparation requires resolved Vite config.")
    if (normalizeWorkflowOptions(workflow, { hosting: "vercel" })?.provider !== "vercel") return
    const rootDir = resolveViteHubProjectRoot(resolved.root)
    const artifacts = await writeProviderEntries(rootDir, workflow, {
      agent: internalOptions?.agentImportBase,
      workflow: internalOptions?.importBase,
      workspace: internalOptions?.workspaceImportBase,
      workspaceDependencies: internalOptions?.workspaceDependencyRuntimeImports,
    }, serverDirs, internalOptions?.includeUserAppEntry, (resolved.plugins as AgentWorkflowRegistryPlugin[])
      .find(plugin => plugin.vitehub?.agent?.transformWorkflowRegistry)
      ?.vitehub?.agent?.transformWorkflowRegistry, providerImportAliases())
    if (!artifacts.providerDefinitions.length) return
    const importBase = internalOptions?.importBase ?? workflowPackageName
    const projectRequire = createRequire(resolve(rootDir, "package.json"))
    const workflowRequire = createRequire(import.meta.url)
    const workflowApi = workflowRequire.resolve("workflow/api")
    return {
      bundleAlias: {
        [`${importBase}/runtime/state`]: projectRequire.resolve(`${importBase}/runtime/state`),
        [`${importBase}/runtime/vercel-vite`]: projectRequire.resolve(`${importBase}/runtime/vercel-vite`),
        "@workflow/core/runtime/world-target": createRequire(workflowApi).resolve("@workflow/world-vercel"),
        "workflow/api": workflowApi,
        "workflow/runtime": workflowRequire.resolve("workflow/runtime"),
      },
      importBase,
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
      providerOutput = useComposedProviderOutput(config)
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
        clientOutDir: resolved.build.outDir,
        importBase: internalOptions?.importBase,
        providerImportAliases: providerImportAliases(),
        providerRuntimeImportAliases: {
          cloudflare: providerRuntimeImportAliases("cloudflare"),
          vercel: providerRuntimeImportAliases("vercel"),
        },
        rootDir: resolveViteHubProjectRoot(resolved.root),
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
