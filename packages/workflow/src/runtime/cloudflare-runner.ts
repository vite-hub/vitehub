import { runWithActiveCloudflareEnv, type CloudflareWorkerEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { runWorkflowHandler } from "./execute.ts"
import { loadWorkflowDefinition, runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"

import type { ResolvedWorkflowOptions, WorkflowDefinitionRegistry, WorkflowProviderStep, WorkflowStepOptions } from "../types.ts"

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

function translateNonRetryableError(
  error: unknown,
  createNonRetryableError: RunCloudflareWorkflowOptions["createNonRetryableError"],
): unknown {
  return createNonRetryableError && isNonRetryableError(error) ? createNonRetryableError(error) : error
}

function wrapCloudflareWorkflowStep(
  step: WorkflowProviderStep | undefined,
  createNonRetryableError: RunCloudflareWorkflowOptions["createNonRetryableError"],
): WorkflowProviderStep | undefined {
  if (!step?.do || !createNonRetryableError) return step
  return {
    async do<TResult>(name: string, options: WorkflowStepOptions, run: () => TResult | Promise<TResult>): Promise<TResult> {
      return await step.do!(name, options, async () => {
        try {
          return await run()
        }
        catch (error) {
          throw translateNonRetryableError(error, createNonRetryableError)
        }
      })
    },
  }
}

export async function runCloudflareWorkflow({ config, createNonRetryableError, env, event, name, registry, step }: RunCloudflareWorkflowOptions): Promise<unknown> {
  setWorkflowRuntimeConfig(config)
  setWorkflowRuntimeRegistry(registry)
  const providerStep = wrapCloudflareWorkflowStep(step, createNonRetryableError)

  return await runWithActiveCloudflareEnv(env, async () => {
    const definition = await loadWorkflowDefinition(name)
    if (!definition) {
      throw new Error(`Missing workflow definition: ${name}`)
    }

    try {
      return await runWithWorkflowRuntimeEvent({ env, step: providerStep }, () => runWorkflowHandler({
        id: event?.instanceId || event?.id,
        name,
        payload: event?.payload,
        provider: "cloudflare",
        step: providerStep,
      }, definition))
    }
    catch (error) {
      throw translateNonRetryableError(error, createNonRetryableError)
    }
  })
}
