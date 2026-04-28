import { definePlugin as defineNitroPlugin } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"

import workflowRegistry from "#vitehub/workflow/registry"

import { runCloudflareWorkflow } from "./cloudflare-runner.ts"
import { enterWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"

import type { ResolvedWorkflowOptions } from "../types.ts"

const workflowNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin((nitroApp) => {
  const runtimeConfig = useRuntimeConfig() as { workflow?: false | ResolvedWorkflowOptions }
  setWorkflowRuntimeConfig(runtimeConfig.workflow)
  setWorkflowRuntimeRegistry(workflowRegistry)
  globalThis.__vitehubRunNitroWorkflowDefinition = async (name, env, event, step) => {
    return await runCloudflareWorkflow({
      config: runtimeConfig.workflow,
      env: env || {},
      event,
      name,
      registry: workflowRegistry,
      step,
    })
  }

  nitroApp.hooks.hook("request", (event) => {
    enterWorkflowRuntimeEvent(event)
  })
})

export default workflowNitroPlugin
