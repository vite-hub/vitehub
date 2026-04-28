import { definePlugin as defineNitroPlugin } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"

import workflowRegistry from "#vitehub/workflow/registry"

import type { CloudflareWorkerEnv } from "@vitehub/internal/runtime/cloudflare-env"

import { runCloudflareWorkflow } from "./cloudflare-runner.ts"
import { enterWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"

import type { ResolvedWorkflowOptions } from "../types.ts"
import type { CloudflareWorkflowEvent } from "./cloudflare-runner.ts"

declare global {
  var __vitehubRunNitroWorkflowDefinition:
    | ((name: string, env: CloudflareWorkerEnv, event: CloudflareWorkflowEvent, step: unknown) => Promise<unknown>)
    | undefined
}

const workflowNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin((nitroApp) => {
  const runtimeConfig = useRuntimeConfig() as { workflow?: false | ResolvedWorkflowOptions }
  setWorkflowRuntimeConfig(runtimeConfig.workflow)
  setWorkflowRuntimeRegistry(workflowRegistry)
  globalThis.__vitehubRunNitroWorkflowDefinition = async (name: string, env: CloudflareWorkerEnv, event: CloudflareWorkflowEvent, step: unknown) => {
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
