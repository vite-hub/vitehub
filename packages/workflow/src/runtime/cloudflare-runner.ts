import { runWithActiveCloudflareEnv, type CloudflareWorkerEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { runSerializedWorkflowHandler } from "./execute.ts"
import { loadWorkflowDefinition, runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"

import type { ResolvedWorkflowOptions, WorkflowDefinitionRegistry, WorkflowProviderStep, WorkflowStepOptions } from "../types.ts"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"
import { isNonRetryableError } from "../errors.ts"

export interface CloudflareWorkflowEvent {
  id?: string
  instanceId?: string
  payload?: unknown
}

export interface RunCloudflareWorkflowOptions {
  config: false | ResolvedWorkflowOptions | undefined
  createNonRetryableError?: (error: Error) => Error
  env: CloudflareWorkerEnv
  event: CloudflareWorkflowEvent
  name: string
  registry: WorkflowDefinitionRegistry
  step?: WorkflowProviderStep
}

/** The Cloudflare errors that a step already made. They pass the run boundary as they are, not wrapped again. */
const cloudflareNonRetryableErrors = new WeakSet<object>()

function translateNonRetryableError(
  error: unknown,
  createNonRetryableError: RunCloudflareWorkflowOptions["createNonRetryableError"],
): unknown {
  if (!createNonRetryableError || !isNonRetryableError(error) || cloudflareNonRetryableErrors.has(error)) return error
  const translated = createNonRetryableError(error)
  cloudflareNonRetryableErrors.add(translated)
  return translated
}

function wrapCloudflareWorkflowStep(
  step: WorkflowProviderStep | undefined,
  createNonRetryableError: RunCloudflareWorkflowOptions["createNonRetryableError"],
  env: CloudflareWorkerEnv,
  runtimeEvent: () => unknown,
): WorkflowProviderStep | undefined {
  if (!step?.do) return step
  // Cloudflare passes `step` as an RPC stub. Call its methods directly: `step.sleep.bind(step)`
  // is a remote call that sends the stub away and disposes it.
  return {
    async do<TResult>(name: string, options: WorkflowStepOptions, run: () => TResult | Promise<TResult>): Promise<TResult> {
      return await step.do!(name, options, async () => await runWithActiveCloudflareEnv(env, async () => await runWithWorkflowRuntimeEvent(runtimeEvent(), async () => {
        try {
          return await run()
        }
        catch (error) {
          throw translateNonRetryableError(error, createNonRetryableError)
        }
      })))
    },
    ...(step.sleep ? { sleep: async (name: string, duration: string) => await step.sleep!(name, duration) } : {}),
  }
}

export async function runCloudflareWorkflow({ config, createNonRetryableError, env, event, name, registry, step }: RunCloudflareWorkflowOptions): Promise<unknown> {
  setWorkflowRuntimeConfig(config)
  setWorkflowRuntimeRegistry(registry)
  let runtimeEvent: unknown
  const providerStep = wrapCloudflareWorkflowStep(step, createNonRetryableError, env, () => runtimeEvent)
  runtimeEvent = { env, step: providerStep }

  return await runWithActiveCloudflareEnv(env, async () => {
    const definition = await loadWorkflowDefinition(name)
    if (!definition) {
      throw workflowErrorDiagnostics.WORKFLOW_R0015({ message: `Missing workflow definition: ${name}` })
    }

    try {
      return await runWithWorkflowRuntimeEvent(runtimeEvent, () => runSerializedWorkflowHandler({
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
