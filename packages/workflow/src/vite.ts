import { getViteMode } from "@vitehub/internal/build/mode"
import { shouldSkipViteProviderBuild } from "@vitehub/internal/build/deployment-output"
import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"

import { generateProviderOutputs, workflowPackageName } from "./internal/vite-build.ts"
import workflowNitroModule from "./nitro/module.ts"

import type { WorkflowModuleOptions } from "./types.ts"
import type { NitroModule } from "nitro/types"
import type { Plugin, ResolvedConfig } from "vite"

export type WorkflowVitePlugin = Plugin & { nitro: NitroModule }

const mergeNoExternal = createNoExternalMerger(workflowPackageName)

export function hubWorkflow(options?: WorkflowModuleOptions): WorkflowVitePlugin {
  let resolved: ResolvedConfig | undefined
  let workflow: WorkflowModuleOptions | undefined = options

  return {
    name: "@vitehub/workflow/vite",
    nitro: workflowNitroModule,
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
        clientOutDir: resolved.build.outDir,
        rootDir: resolved.root,
        workflow,
      })
    },
  }
}

declare module "vite" {
  interface UserConfig {
    workflow?: WorkflowModuleOptions
  }
}
