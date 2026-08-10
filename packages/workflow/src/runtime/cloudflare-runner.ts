import { runWithActiveCloudflareEnv, type CloudflareWorkerEnv } from "@vite-hub/internal/runtime/cloudflare-env"

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
  createNonRetryableError?: (error: Error & { isRetryable: false }) => Error
  env: CloudflareWorkerEnv
  event: CloudflareWorkflowEvent
  name: string
  registry: WorkflowDefinitionRegistry
  step?: WorkflowProviderStep
}

function isNonRetryableError(error: unknown): error is Error & { isRetryable: false } {
  return error instanceof Error && (error as { isRetryable?: unknown }).isRetryable === false
}

export async function runCloudflareWorkflow({ config, createNonRetryableError, env, event, name, registry, step }: RunCloudflareWorkflowOptions): Promise<unknown> {
  setWorkflowRuntimeConfig(config)
  setWorkflowRuntimeRegistry(registry)

  return await runWithActiveCloudflareEnv(env, async () => {
    const definition = await loadWorkflowDefinition(name)
    if (!definition) {
      throw new Error(`Missing workflow definition: ${name}`)
    }

    try {
      return await runWithWorkflowRuntimeEvent({ env, step }, () => runWorkflowHandler({
        id: event?.instanceId || event?.id,
        name,
        payload: event?.payload,
        provider: "cloudflare",
        step,
      }, definition))
    }
    catch (error) {
      if (createNonRetryableError && isNonRetryableError(error)) throw createNonRetryableError(error)
      throw error
    }
  })
}
