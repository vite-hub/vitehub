import workflowNitroModule from "./nitro/module.ts"
import { generateProviderOutputs, workflowPackageName } from "./internal/vite-build.ts"

import type { WorkflowModuleOptions } from "./types.ts"
import type { NitroModule } from "nitro/types"
import type { Plugin } from "vite"

export type WorkflowVitePlugin = Plugin & { nitro: NitroModule }

function mergeNoExternal(current: boolean | string | RegExp | (string | RegExp)[] | undefined) {
  if (current === true) {
    return true
  }

  if (!current) {
    return [workflowPackageName]
  }

  const values = Array.isArray(current) ? current : [current]
  return values.some(value => value === workflowPackageName) ? values : [...values, workflowPackageName]
}

function isWorkflowServerEnvironment(name: string, config: { consumer?: string }) {
  return name === "ssr" || config.consumer === "server"
}

export function hubWorkflow(options?: WorkflowModuleOptions): WorkflowVitePlugin {
  let clientOutDir = "dist"
  let command: "build" | "serve" = "serve"
  let rootDir = process.cwd()
  let workflow: WorkflowModuleOptions | undefined = options

  return {
    name: "@vitehub/workflow/vite",
    nitro: workflowNitroModule,
    config(config, env) {
      command = env.command
      workflow = config.workflow ?? workflow
    },
    configResolved(config) {
      clientOutDir = config.build.outDir
      rootDir = config.root
      workflow = config.workflow ?? workflow
    },
    configEnvironment(name, config) {
      if (!isWorkflowServerEnvironment(name, config)) {
        return
      }

      return {
        resolve: {
          noExternal: mergeNoExternal(config.resolve?.noExternal),
        },
      }
    },
    async closeBundle() {
      if (command === "serve") {
        return
      }

      await generateProviderOutputs({
        clientOutDir,
        rootDir,
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
