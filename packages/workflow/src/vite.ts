import { getViteMode } from "@vite-hub/internal/build/mode"
import { shouldSkipViteProviderBuild } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalMerger, isServerEnvironment, resolveNitroVercelFunctionName, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { generateProviderOutputs, workflowPackageName } from "./internal/vite-build.ts"

import type { WorkflowModuleOptions } from "./types.ts"
import type { Plugin, ResolvedConfig } from "vite"

export type WorkflowVitePlugin = Plugin

const mergeNoExternal = createNoExternalMerger(workflowPackageName)

type InternalWorkflowModuleOptions = Exclude<WorkflowModuleOptions, false> & {
  agentImportBase?: string
  importBase?: string
  providerImportAliases?: Record<string, string>
  userAppEntry?: boolean
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
        userAppEntry: internalOptions?.userAppEntry,
        workflow,
        workspaceDependencyRuntimeImports: internalOptions?.workspaceDependencyRuntimeImports,
        workspaceImportBase: internalOptions?.workspaceImportBase,
      })
    },
  }
}

declare module "vite" {
  interface UserConfig {
    workflow?: WorkflowModuleOptions
  }
}
