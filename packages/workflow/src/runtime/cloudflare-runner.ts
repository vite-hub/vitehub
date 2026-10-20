import { runWithActiveCloudflareEnv, type CloudflareWorkerEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { runSerializedWorkflowHandler } from "./execute.ts"
import { loadWorkflowDefinition, runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"
import { hasRuntimeType } from "../internal/runtime-type.ts"

import type { ResolvedWorkflowOptions, WorkflowDefinitionRegistry, WorkflowProviderStep, WorkflowStepOptions } from "../types.ts"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"

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
  if (!hasRuntimeType(error, "object") || error === null) return false
  try {
    const candidate = error as object
    const retryable = Reflect.get(candidate, "isRetryable")
    if (retryable !== false) return false
    const nativeIsError: unknown = Reflect.get(Error, "isError")
    if (hasRuntimeType(nativeIsError, "function")) {
      return (nativeIsError as (value: unknown) => unknown)(candidate) === true
    }


    const clone = Reflect.get(globalThis, "structuredClone")
    if (!hasRuntimeType(clone, "function")) return false
    try {
      return (clone as (value: unknown) => unknown)(candidate) instanceof Error
    }
    catch {
      // Error objects can carry configurable, non-cloneable application fields.
      // Hide those fields for the brand check, then restore the object exactly.
      const descriptors = new Map<PropertyKey, PropertyDescriptor>()
      try {
        for (const key of Reflect.ownKeys(candidate)) {
          const descriptor = Reflect.getOwnPropertyDescriptor(candidate, key)
          if (!descriptor?.configurable || !("value" in descriptor)) continue
          descriptors.set(key, descriptor)
          Reflect.defineProperty(candidate, key, { ...descriptor, value: undefined })
        }
        try {
          return (clone as (value: unknown) => unknown)(candidate) instanceof Error
        }
        catch {
          return false
        }
      }
      finally {
        for (const [key, descriptor] of descriptors) Reflect.defineProperty(candidate, key, descriptor)
      }
    }
  }
  catch {
    return false
  }
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
  env: CloudflareWorkerEnv,
  runtimeEvent: () => unknown,
): WorkflowProviderStep | undefined {
  if (!step?.do) return step
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
    ...(step.sleep ? { sleep: step.sleep.bind(step) } : {}),
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
