import { setActiveCloudflareEnv, type CloudflareWorkerEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { runWorkflowHandler } from "./execute.ts"
import { loadWorkflowDefinition, runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"

import type { ResolvedWorkflowOptions, WorkflowDefinitionRegistry, WorkflowProviderStep } from "../types.ts"

export interface CloudflareWorkflowEvent {
  id?: string
  instanceId?: string
  payload?: unknown
}

export interface RunCloudflareWorkflowOptions {
  config: false | ResolvedWorkflowOptions | undefined
  env: CloudflareWorkerEnv
  event: CloudflareWorkflowEvent
  name: string
  registry: WorkflowDefinitionRegistry
  step?: WorkflowProviderStep
}

export async function runCloudflareWorkflow({ config, env, event, name, registry, step }: RunCloudflareWorkflowOptions): Promise<unknown> {
  setWorkflowRuntimeConfig(config)
  setWorkflowRuntimeRegistry(registry)
  setActiveCloudflareEnv(env)

  const definition = await loadWorkflowDefinition(name)
  if (!definition) {
    throw new Error(`Missing workflow definition: ${name}`)
  }

  return await runWithWorkflowRuntimeEvent({ env, step }, () => runWorkflowHandler({
    id: event?.instanceId || event?.id,
    name,
    payload: event?.payload,
    provider: "cloudflare",
    step,
  }, definition))
}
