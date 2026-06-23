import { defineCapability } from "../capability-runtime.ts"

import type {
  AgentActor,
  AgentCapabilityDefinition,
  AgentCapabilityRuntimeContext,
  AgentFinishEvent,
  AgentInvoker,
  AgentModelExecutionInstrumentation,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  MaybePromise,
  ResolvedAgentRuntimeContext,
} from "../types.ts"

export type AgentObservabilityStatus = "completed" | "failed"

export interface AgentObservabilityEventBase<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  actor: AgentActor
  input: AgentRunInput
  invoker: AgentInvoker
  run?: AgentRunMetadata
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>
}

export interface AgentObservabilityStartEvent<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends AgentObservabilityEventBase<TRuntimeConfig> {
  type: "start"
}

export interface AgentObservabilityFinishEvent<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends AgentObservabilityEventBase<TRuntimeConfig> {
  durationMs: number
  result: unknown
  status: "completed"
  type: "finish"
}

export interface AgentObservabilityErrorEvent<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> extends AgentObservabilityEventBase<TRuntimeConfig> {
  durationMs: number
  error: unknown
  status: "failed"
  type: "error"
}

export type AgentObservabilityEvent<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  | AgentObservabilityStartEvent<TRuntimeConfig>
  | AgentObservabilityFinishEvent<TRuntimeConfig>
  | AgentObservabilityErrorEvent<TRuntimeConfig>

export type AgentObservabilityEventHandler<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  (event: AgentObservabilityEvent<TRuntimeConfig>) => MaybePromise<void>

export interface AgentObservabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  instrumentation?: AgentModelExecutionInstrumentation<TRuntimeConfig, CALL_OPTIONS>
  onEvent?: AgentObservabilityEventHandler<TRuntimeConfig>
}

export interface AgentObservabilityFinishExtension {
  durationMs: number
  resultKind?: string
  status: AgentObservabilityStatus
}

interface AgentObservabilityCapabilityMetadata<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  kind: "observability"
  observability: AgentObservabilityOptions<TRuntimeConfig, CALL_OPTIONS>
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in value)
}

function resultKind(result: unknown): string {
  if (result === null) return "null"
  if (isAsyncIterable(result)) return "stream"
  if (Array.isArray(result)) return "array"
  return typeof result
}

function capabilityEventBase<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentCapabilityRuntimeContext<TRuntimeConfig>,
): AgentObservabilityEventBase<TRuntimeConfig> {
  return {
    actor: context.actor,
    input: context.input.get(),
    invoker: context.invoker,
    run: context.run,
    runtime: context.runtimeContext as ResolvedAgentRuntimeContext<TRuntimeConfig>,
  }
}

function finishEventBase<TRuntimeConfig extends AgentRuntimeConfig>(
  event: AgentFinishEvent<TRuntimeConfig>,
): AgentObservabilityEventBase<TRuntimeConfig> {
  return {
    actor: event.actor,
    input: event.input,
    invoker: event.invoker,
    run: event.invocation.run,
    runtime: event.runtime,
  }
}

async function notify<TRuntimeConfig extends AgentRuntimeConfig>(
  onEvent: AgentObservabilityEventHandler<TRuntimeConfig> | undefined,
  event: AgentObservabilityEvent<TRuntimeConfig>,
): Promise<void> {
  try {
    await onEvent?.(event)
  }
  catch {
    // Observability sinks must not change Agent Invocation behavior.
  }
}

export function observability<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(options: AgentObservabilityOptions<TRuntimeConfig, CALL_OPTIONS> = {}): AgentCapabilityDefinition<TRuntimeConfig> {
  return defineCapability({
    id: "observability",
    metadata: {
      kind: "observability",
      observability: options,
    } satisfies AgentObservabilityCapabilityMetadata<TRuntimeConfig, CALL_OPTIONS>,
    configure(context) {
      if (options.instrumentation) context.modelExecution.instrument(options.instrumentation as never)
      context.finish.provide(async (event: AgentFinishEvent<TRuntimeConfig>) => {
        if (event.error !== undefined) {
          return {
            durationMs: event.invocation.durationMs,
            status: "failed",
          } satisfies AgentObservabilityFinishExtension
        }

        return {
          durationMs: event.invocation.durationMs,
          resultKind: resultKind(event.result),
          status: "completed",
        } satisfies AgentObservabilityFinishExtension
      })
      // Returning false reuses finish-time lifecycle scheduling without creating a Channel Delivery Effect.
      context.delivery.finishEffect(async (event): Promise<false> => {
        if (event.error !== undefined) {
          await notify(options.onEvent, {
            ...finishEventBase(event as AgentFinishEvent<TRuntimeConfig>),
            durationMs: event.invocation.durationMs,
            error: event.error,
            status: "failed",
            type: "error",
          })
          return false
        }

        await notify(options.onEvent, {
          ...finishEventBase(event as AgentFinishEvent<TRuntimeConfig>),
          durationMs: event.invocation.durationMs,
          result: event.result,
          status: "completed",
          type: "finish",
        })
        return false
      })
    },
    input(context) {
      return notify(options.onEvent, {
        ...capabilityEventBase(context),
        type: "start",
      })
    },
  })
}
