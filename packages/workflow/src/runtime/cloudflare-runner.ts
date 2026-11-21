import { runWithActiveCloudflareEnv, type CloudflareWorkerEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { hasRunFailedListeners } from "@vite-hub/runtime/internal/run-failed"

import { createWorkflowError } from "../errors.ts"

import { fromCloudflareStartParams } from "./delay.ts"
import { resolveWorkflowStepOptions, runSerializedWorkflowHandler } from "./execute.ts"
import { emitWorkflowFailed } from "./run-failed.ts"
import { loadWorkflowDefinition, runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"

import type { ResolvedWorkflowOptions, WorkflowDefinitionRegistry, WorkflowProviderStep, WorkflowStepOptions } from "../types.ts"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"
import { isNonRetryableError } from "../errors.ts"

export interface CloudflareWorkflowEvent {
  id?: string
  instanceId?: string
  payload?: unknown
}

/** The `step` of a Cloudflare Workflow: the ViteHub step runner names, and `waitForEvent()`. */
export interface CloudflareWorkflowStep extends Omit<WorkflowProviderStep, "waitForSignal"> {
  waitForEvent?: (name: string, options: { timeout?: string, type: string }) => Promise<{ payload?: unknown }>
}

export interface RunCloudflareWorkflowOptions {
  config: false | ResolvedWorkflowOptions | undefined
  createNonRetryableError?: (error: Error) => Error
  env: CloudflareWorkerEnv
  event: CloudflareWorkflowEvent
  name: string
  registry: WorkflowDefinitionRegistry
  step?: CloudflareWorkflowStep
}

/**
 * The Cloudflare event type of a signal wait, such as `vitehub-signal-1`. `resumeWorkflow()` sends the event of this
 * type to the instance.
 */
export function cloudflareSignalEventType(signal: string): string {
  return `vitehub-${signal}`
}

/** Cloudflare waits 24 hours for an event by default. A signal waits as long as Cloudflare allows. */
const cloudflareSignalTimeout = "365 days"

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
  step: CloudflareWorkflowStep | undefined,
  createNonRetryableError: RunCloudflareWorkflowOptions["createNonRetryableError"],
  env: CloudflareWorkerEnv,
  runtimeEvent: () => unknown,
): WorkflowProviderStep | undefined {
  if (!step?.do) return step
  // Cloudflare passes `step` as an RPC stub. Call its methods directly: `step.sleep.bind(step)`
  // is a remote call that sends the stub away and disposes it.
  return {
    async do<TResult>(name: string, options: WorkflowStepOptions, run: () => TResult | Promise<TResult>): Promise<TResult> {
      // Cloudflare reads `retries` and `timeout` as they are. ViteHub fills in its default retries, not Cloudflare's.
      return await step.do!(name, resolveWorkflowStepOptions(name, options), async () => await runWithActiveCloudflareEnv(env, async () => await runWithWorkflowRuntimeEvent(runtimeEvent(), async () => {
        try {
          return await run()
        }
        catch (error) {
          throw translateNonRetryableError(error, createNonRetryableError)
        }
      })))
    },
    ...(step.sleep ? { sleep: async (name: string, milliseconds: number) => await step.sleep!(name, milliseconds) } : {}),
    ...(step.sleepUntil ? { sleepUntil: async (name: string, date: Date) => await step.sleepUntil!(name, date) } : {}),
    ...(step.waitForEvent
      ? { waitForSignal: async (name: string) => (await step.waitForEvent!(name, { timeout: cloudflareSignalTimeout, type: cloudflareSignalEventType(name) })).payload }
      : {}),
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

    // A delayed start sleeps first. A sleeping instance does not count toward the concurrency limit. On replay, the
    // finished sleep returns at once.
    const { payload, startAt } = fromCloudflareStartParams(event?.payload)
    if (startAt !== undefined) {
      if (!step?.sleepUntil) throw createWorkflowError({ code: "WORKFLOW_OPERATION_UNSUPPORTED", details: { operation: "delay", provider: "cloudflare" } })
      await step.sleepUntil("vitehub-delay", new Date(startAt))
    }

    const id = event?.instanceId || event?.id
    try {
      return await runWithWorkflowRuntimeEvent(runtimeEvent, () => runSerializedWorkflowHandler({
        id,
        name,
        payload,
        provider: "cloudflare",
        step: providerStep,
      }, definition))
    }
    catch (error) {
      // Cloudflare retries each step on its own. An error that leaves `run()` ends the instance as errored.
      if (id && hasRunFailedListeners() && !definition.internalAgentWorkflow && !definition.internalAgentInvocationRecovery) {
        try {
          if (providerStep?.do) {
            await providerStep.do("vitehub-notify-terminal-failure", { retries: { limit: 0 } }, async () => {
              await emitWorkflowFailed(name, id, error, definition)
              return null
            })
          }
          else await emitWorkflowFailed(name, id, error, definition)
        }
        catch (notificationError) {
          console.error("[vitehub] Could not checkpoint the Workflow failure notification.", notificationError)
        }
      }
      throw translateNonRetryableError(error, createNonRetryableError)
    }
  })
}
