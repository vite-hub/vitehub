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
    const nativeIsError: unknown = Reflect.get(Error, "isError")
    const branded = hasRuntimeType(nativeIsError, "function")
      ? (nativeIsError as (value: unknown) => unknown)(error) === true
      : (() => {
        const prototype = Object.getPrototypeOf(error)
        if (prototype === null || prototype === Object.prototype || Object.prototype.toString.call(error) !== "[object Error]") return false
        let errorPrototype: object | null = prototype
        let hasErrorPrototype = false
        let intrinsicPrototype: object | null = null
        while (errorPrototype !== null) {
          if (Object.prototype.hasOwnProperty.call(errorPrototype, "toString")
            && Object.prototype.hasOwnProperty.call(errorPrototype, "constructor")
            && hasRuntimeType(Reflect.get(errorPrototype, "constructor"), "function")
            && Reflect.get(Reflect.get(errorPrototype, "constructor"), "name") === "Error") {
            hasErrorPrototype = true
            intrinsicPrototype = errorPrototype
            break
          }
          errorPrototype = Object.getPrototypeOf(errorPrototype)
        }
        const hasIntrinsicErrorFields = intrinsicPrototype !== null
          && Object.prototype.hasOwnProperty.call(intrinsicPrototype, "name")
          && Object.prototype.hasOwnProperty.call(intrinsicPrototype, "message")
          && Reflect.get(intrinsicPrototype, "name") === "Error"
        const errorRecord = error as Record<PropertyKey, unknown>
        const stackDescriptor = Object.getOwnPropertyDescriptor(errorRecord, "stack")
        const isNativeStackAccessor = typeof stackDescriptor?.get === "function"
          && Function.prototype.toString.call(stackDescriptor.get).includes("[native code]")
        return hasErrorPrototype && hasIntrinsicErrorFields && isNativeStackAccessor
          // Real Error instances receive a native lazy stack accessor. Requiring
          // that descriptor shape rejects Error.prototype-derived records that
          // fabricate a stack value while retaining foreign Error instances.
          && Object.prototype.hasOwnProperty.call(errorRecord, "stack")
          && typeof stackDescriptor?.get === "function"
          && typeof stackDescriptor.set === "function"
          && stackDescriptor.configurable === true
          && stackDescriptor.enumerable === false
      })()
    return branded && Reflect.get(error as object, "isRetryable") === false
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
