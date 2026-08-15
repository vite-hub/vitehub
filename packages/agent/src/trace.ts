import { emitTraceEvent } from "@vite-hub/runtime"

import { agentErrorDetails } from "./agent-error.ts"
import type { StreamEvent } from "./messages.ts"
import type {
  AgentInvocationContextStore,
  AgentChannelDeliveryEffectIntent,
  AgentInvoker,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  ResolvedAgentRuntimeContext,
} from "./types.ts"
import type { Telemetry } from "ai"
import type { TraceEvent } from "@vite-hub/runtime"

export const agentInvocationJournalTraceLogSymbol: unique symbol = Symbol("vitehub.agent.invocationJournalTraceLog")

export interface AgentTraceContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  context: AgentInvocationContextStore
  input: AgentRunInput
  invoker: AgentInvoker
  run?: AgentRunMetadata
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>
}

export function hasAgentTraceLog(context: { runtime: ResolvedAgentRuntimeContext }): boolean {
  return Boolean(context.runtime.traceLog)
}

function invocationAttributes(context: AgentTraceContext, extra: Record<string, unknown> = {}) {
  return {
    "agent.invoker.id": context.invoker.id,
    "agent.invoker.kind": context.invoker.kind,
    "agent.run.id": context.run?.runId,
    "channel.delivery.id": context.runtime.channelDelivery?.id,
    "channel.delivery.provider": context.runtime.channelDelivery?.provider,
    "channel.delivery.source.id": context.runtime.channelDelivery?.sourceId,
    "input.hasMessages": Boolean(context.input.messages?.length),
    "input.hasPrompt": Boolean(context.input.prompt),
    "input.messages": context.input.messages,
    "input.prompt": context.input.prompt,
    "runtime.name": context.runtime.runtime,
    ...extra,
  }
}

function eventAttributes(event: StreamEvent): Record<string, unknown> {
  if (event.type === "text-delta") {
    return {
      "message.content": event.text,
      "message.id": event.messageId || event.id,
      "message.phase": event.phase,
      "message.role": event.role || "assistant",
      "vitehub.activity.kind": event.phase === "commentary" ? "reasoning" : "message",
    }
  }
  if (event.type === "tool-call" || event.type === "tool-input-start") {
    return {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.call.id": event.id,
      "gen_ai.tool.name": event.name,
      "step.id": event.id,
      "tool.id": event.id,
      "tool.name": event.name,
      "tool.hasInput": event.input !== undefined,
      "tool.input": event.input,
      "vitehub.activity.kind": event.activity?.kind || "tool",
      "vitehub.action.name": event.activity?.kind === "action" ? event.activity.name : undefined,
    }
  }
  if (event.type === "tool-result") {
    return {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.call.id": event.id,
      "gen_ai.tool.name": event.name,
      "step.id": event.id,
      "tool.id": event.id,
      "tool.name": event.name,
      "tool.hasOutput": event.output !== undefined,
      "tool.output": event.output,
      "tool.error": event.error,
      "vitehub.activity.kind": event.activity?.kind || "tool",
      "vitehub.action.name": event.activity?.kind === "action" ? event.activity.name : undefined,
    }
  }
  if (event.type === "approval-request") {
    return {
      "approval.id": event.id,
      "approval.name": event.name,
      "approval.reason": event.reason,
      "approval.hasInput": event.input !== undefined,
      "approval.input": event.input,
    }
  }
  if (event.type === "approval-decision") {
    return {
      "approval.approved": event.approved,
      "approval.id": event.id,
      "approval.reason": event.reason,
    }
  }
  if (event.type === "usage") {
    return {
      "usage.hasCost": event.usageRecord.cost !== undefined,
      "usage.hasRaw": event.usageRecord.raw !== undefined,
      "usage.totalTokens": event.usageRecord.usage?.totalTokens,
    }
  }
  if (event.type === "error") {
    return {
      "error.message": event.error,
      "error.recoverable": event.recoverable,
    }
  }
  if (event.type === "finish") {
    return { "finish.reason": event.reason }
  }
  return {}
}

function streamTitle(event: StreamEvent): string | undefined {
  if ((event.type !== "data" && !event.type.startsWith("data-")) || !("data" in event)) return
  if (!event.data || typeof event.data !== "object") return
  const data = event.data as { title?: unknown, type?: unknown }
  return data.type === "title" && typeof data.title === "string" && data.title.trim()
    ? data.title.trim()
    : undefined
}

export async function traceAgentEvent<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentTraceContext<TRuntimeConfig>,
  event: TraceEvent,
): Promise<void> {
  try {
    const attributes = context.run?.runId
      ? { "agent.run.id": context.run.runId, ...event.attributes }
      : event.attributes
    await emitTraceEvent(context.runtime, {
      ...event,
      ...(attributes ? { attributes } : {}),
      trace: event.trace || context.runtime.trace,
    })
  }
  catch {
    // Trace sinks must not change Agent Invocation behavior.
  }
}

export async function traceAgentInvocationStart<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentTraceContext<TRuntimeConfig>,
): Promise<void> {
  await traceAgentEvent(context, {
    attributes: invocationAttributes(context),
    name: "agent.invocation.start",
    type: "run",
  })
}

export async function traceAgentInvocationFinish<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentTraceContext<TRuntimeConfig>,
  attributes: Record<string, unknown> = {},
): Promise<void> {
  await traceAgentEvent(context, {
    attributes: invocationAttributes(context, attributes),
    name: "agent.invocation.finish",
    type: "run",
  })
}

export async function traceAgentInvocationError<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentTraceContext<TRuntimeConfig>,
  error: unknown,
): Promise<void> {
  const details = agentErrorDetails(error)
  await traceAgentEvent(context, {
    attributes: invocationAttributes(context, {
      "error.message": details.message,
      "error.name": details.name,
    }),
    name: "agent.invocation.error",
    type: "error",
  })
}

export async function traceAgentChannelDeliveryEffect<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentTraceContext<TRuntimeConfig>,
  effect: AgentChannelDeliveryEffectIntent,
  attributes: Record<string, unknown> = {},
): Promise<void> {
  await traceAgentEvent(context, {
    attributes: invocationAttributes(context, {
      "channel.effect.intent": effect.intent,
      "channel.effect.kind": effect.kind,
      ...attributes,
    }),
    name: "agent.channel.delivery.effect",
    type: "run",
  })
}

export async function traceAgentStreamEvent<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentTraceContext<TRuntimeConfig>,
  event: unknown,
): Promise<void> {
  if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") return
  const streamEvent = event as StreamEvent
  const title = streamTitle(streamEvent)
  if (title) {
    await traceAgentEvent(context, {
      attributes: { "vitehub.session.title": title },
      name: "agent.title.recorded",
      type: "run",
    })
    return
  }
  const names = {
    "approval-decision": "agent.approval.decision",
    "approval-request": "agent.approval.request",
    error: "agent.stream.error",
    finish: "agent.stream.finish",
    "tool-call": "agent.tool.start",
    "tool-input-start": "agent.tool.start",
    "tool-result": streamEvent.type === "tool-result" && streamEvent.error ? "agent.tool.error" : "agent.tool.finish",
    "text-delta": streamEvent.type === "text-delta" && streamEvent.phase === "commentary" ? "agent.reasoning" : "agent.message",
    usage: "agent.usage.recorded",
  } as const
  const name = streamEvent.type in names ? names[streamEvent.type as keyof typeof names] : undefined
  if (!name) return

  await traceAgentEvent(context, {
    attributes: eventAttributes(streamEvent),
    name,
    type: streamEvent.type.startsWith("approval") ? "approval" : streamEvent.type === "error" || (streamEvent.type === "tool-result" && streamEvent.error) ? "error" : "run",
  })
}

export function createAgentStreamEventTracer<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentTraceContext<TRuntimeConfig>,
) {
  let pendingText: Extract<StreamEvent, { type: "text-delta" }> | undefined
  const flush = async () => {
    if (!pendingText) return
    const event = pendingText
    pendingText = undefined
    await traceAgentStreamEvent(context, event)
  }
  return {
    flush,
    async write(event: StreamEvent) {
      if (event.type !== "text-delta") {
        await flush()
        await traceAgentStreamEvent(context, event)
        return
      }
      if (pendingText
        && pendingText.id === event.id
        && pendingText.messageId === event.messageId
        && pendingText.phase === event.phase
        && pendingText.role === event.role) {
        pendingText = { ...pendingText, text: pendingText.text + event.text }
        return
      }
      await flush()
      pendingText = event
    },
  }
}

export function traceAgentStreamEvents<TRuntimeConfig extends AgentRuntimeConfig>(
  events: AsyncIterable<unknown>,
  context: AgentTraceContext<TRuntimeConfig>,
): AsyncIterable<StreamEvent> {
  return (async function* () {
    for await (const event of events) {
      await traceAgentStreamEvent(context, event)
      yield event as StreamEvent
    }
  })()
}

function valueFromPath(value: unknown, path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0)
}

export function aiSdkTelemetryIntegration<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentTraceContext<TRuntimeConfig>,
): Telemetry {
  const modelAttributes = (event: unknown) => ({
    "model.id": firstString(valueFromPath(event, ["model", "modelId"]), valueFromPath(event, ["model", "id"]), valueFromPath(event, ["modelId"])),
    "model.provider": firstString(valueFromPath(event, ["model", "provider"]), valueFromPath(event, ["provider"])),
    "model.call.id": firstString(valueFromPath(event, ["id"]), valueFromPath(event, ["callId"]), valueFromPath(event, ["requestId"])) || "model",
  })
  const toolAttributes = (event: unknown) => ({
    "step.id": firstString(valueFromPath(event, ["toolCall", "toolCallId"]), valueFromPath(event, ["toolCallId"]), valueFromPath(event, ["id"]), valueFromPath(event, ["tool", "id"])) || "tool",
    "tool.id": firstString(valueFromPath(event, ["toolCall", "toolCallId"]), valueFromPath(event, ["toolCallId"]), valueFromPath(event, ["id"]), valueFromPath(event, ["tool", "id"])),
    "tool.name": firstString(valueFromPath(event, ["toolCall", "toolName"]), valueFromPath(event, ["toolName"]), valueFromPath(event, ["name"]), valueFromPath(event, ["tool", "name"])),
  })

  return {
    async onLanguageModelCallEnd(event) {
      await traceAgentEvent(context, {
        attributes: modelAttributes(event),
        name: "agent.model.call.finish",
        type: "run",
      })
    },
    async onLanguageModelCallStart(event) {
      await traceAgentEvent(context, {
        attributes: modelAttributes(event),
        name: "agent.model.call.start",
        type: "run",
      })
    },
    async onToolExecutionEnd(event) {
      const outputType = valueFromPath(event, ["toolOutput", "type"])
      const error = valueFromPath(event, ["toolOutput", "error"]) ?? valueFromPath(event, ["error"])
      const failed = outputType === "tool-error" || error !== undefined
      await traceAgentEvent(context, {
        attributes: {
          ...toolAttributes(event),
          "error.message": error instanceof Error ? error.message : typeof error === "string" ? error : undefined,
        },
        name: failed ? "agent.tool.error" : "agent.tool.finish",
        type: failed ? "error" : "run",
      })
    },
    async onToolExecutionStart(event) {
      await traceAgentEvent(context, {
        attributes: toolAttributes(event),
        name: "agent.tool.start",
        type: "run",
      })
    },
  }
}
