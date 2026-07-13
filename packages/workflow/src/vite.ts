import { getViteMode } from "@vite-hub/internal/build/mode"
import { shouldSkipViteProviderBuild } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalMerger, isServerEnvironment } from "@vite-hub/internal/build/vite"

import { generateProviderOutputs, workflowPackageName } from "./internal/vite-build.ts"

import type { WorkflowModuleOptions } from "./types.ts"
import type { Plugin, ResolvedConfig } from "vite"

export type WorkflowVitePlugin = Plugin

type InternalWorkflowModuleOptions = Extract<WorkflowModuleOptions, object> & {
  agentImportBase?: string
  importBase?: string
}

const mergeNoExternal = createNoExternalMerger(workflowPackageName)

function getInternalWorkflowOptions(options: WorkflowModuleOptions | undefined): InternalWorkflowModuleOptions | undefined {
  return typeof options === "object" && options
    ? options as InternalWorkflowModuleOptions
    : undefined
}

function toPublicWorkflowOptions(options: WorkflowModuleOptions | undefined): WorkflowModuleOptions | undefined {
  if (typeof options !== "object" || !options) return options
  const { agentImportBase: _agentImportBase, importBase: _importBase, ...publicOptions } = options as InternalWorkflowModuleOptions
  return publicOptions
}

export function hubWorkflow(options?: WorkflowModuleOptions): WorkflowVitePlugin {
  let resolved: ResolvedConfig | undefined
  let workflow: WorkflowModuleOptions | undefined = options

  return {
    name: "@vite-hub/workflow/vite",
    config(config) {
      workflow = config.workflow ?? workflow
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
        agentImportBase: getInternalWorkflowOptions(workflow)?.agentImportBase,
        clientOutDir: resolved.build.outDir,
        importBase: getInternalWorkflowOptions(workflow)?.importBase,
        rootDir: resolved.root,
        workflow: toPublicWorkflowOptions(workflow),
      })
    },
  }
}

declare module "vite" {
  interface UserConfig {
    workflow?: WorkflowModuleOptions
  }
}
