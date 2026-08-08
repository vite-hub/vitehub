import { getViteMode } from "@vite-hub/internal/build/mode"
import { shouldSkipViteProviderBuild } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalMerger, isServerEnvironment, resolveNitroVercelFunctionName, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { createCloudflareWorkflowNitroConfig, generateProviderOutputs, workflowPackageName } from "./internal/vite-build.ts"

import type { WorkflowModuleOptions } from "./types.ts"
import type { Plugin, ResolvedConfig } from "vite"

interface WorkflowNitroConfigOptions {
  nitro: Record<string, unknown>
  projectRoot: string
  serverDirs?: string[]
}

export type WorkflowVitePlugin = Plugin & {
  vitehub?: {
    workflow?: {
      createNitroConfig?: (options: WorkflowNitroConfigOptions) => Promise<Record<string, unknown>>
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
  let resolved: ResolvedConfig | undefined
  let workflow: WorkflowModuleOptions | undefined = options
  let serverDirs: string[] | undefined

  return {
    name: "@vite-hub/workflow/vite",
    config(config) {
      workflow = config.workflow ?? workflow
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
    },
    configResolved(config) {
      resolved = config
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
        async createNitroConfig({ nitro, projectRoot, serverDirs: nitroServerDirs }: WorkflowNitroConfigOptions) {
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
          })
        },
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
        providerImportAliases: {
          ...resolveStringAliases(resolved),
          ...internalOptions?.providerImportAliases,
        },
        rootDir: resolved.root,
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
