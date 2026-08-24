import { hasRuntimeType } from "./internal/runtime-type.ts"
import { emitTraceEvent } from "@vite-hub/runtime"

import { agentErrorDetails } from "./agent-error.ts"
import type { AgentActivity, StreamEvent } from "./messages.ts"
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
export const agentInvocationJournalContentTraceLogSymbol: unique symbol = Symbol("vitehub.agent.invocationJournalContentTraceLog")
const MAX_TRACE_TEXT_EVENT_LENGTH = 64 * 1024

export interface AgentTraceContext<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  context: AgentInvocationContextStore
  input: AgentRunInput
  invoker: AgentInvoker
  run?: AgentRunMetadata
  runtime: ResolvedAgentRuntimeContext<TRuntimeConfig>
}

export const agentInvocationTraceIdContextKey = "agent.invocation.traceId"

export function hasAgentTraceLog(context: { runtime: ResolvedAgentRuntimeContext }): boolean {
  return Boolean(context.runtime.traceLog)
}

function invocationAttributes(
  context: AgentTraceContext,
  extra: Record<string, unknown> = {},
  includeInput = false,
) {
  return {
    "agent.invoker.id": context.invoker.id,
    "agent.invoker.kind": context.invoker.kind,
    "agent.run.id": context.run?.runId,
    "channel.delivery.id": context.runtime.channelDelivery?.id,
    "channel.delivery.provider": context.runtime.channelDelivery?.provider,
    "channel.delivery.source.id": context.runtime.channelDelivery?.sourceId,
    "input.hasMessages": Boolean(context.input.messages?.length),
    "input.hasPrompt": Boolean(context.input.prompt),
    ...(includeInput && context.input.messages?.length ? { "input.messages": context.input.messages } : {}),
    ...(includeInput && context.input.prompt ? { "input.prompt": context.input.prompt } : {}),
    "runtime.name": context.runtime.runtime,
    ...extra,
  }
}

function eventAttributes(event: StreamEvent): Record<string, unknown> {
  if (event.type === "text-delta") {
    return {
      "message.content": event.text,
      "message.id": event.messageId ?? event.id,
      "message.phase": event.phase,
      "message.role": event.role ?? "assistant",
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
      "tool.title": event.title,
      "tool.hasInput": event.input !== undefined,
      ...(event.input !== undefined ? { "tool.input": event.input } : {}),
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
      "tool.title": event.title,
      "tool.durationMs": event.durationMs,
      "tool.hasOutput": event.output !== undefined,
      ...(event.output !== undefined ? { "tool.output": event.output } : {}),
      "tool.error": event.error,
      "vitehub.activity.kind": event.activity?.kind || "tool",
      "vitehub.action.name": event.activity?.kind === "action" ? event.activity.name : undefined,
    }
  }
  if (event.type === "approval-request") {
    return {
      "approval.id": event.id,
      ...(event.input !== undefined ? { "approval.input": event.input } : {}),
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
    const reasoningTokens = event.usageRecord.usage?.outputTokenDetails?.reasoningTokens
      ?? event.usageRecord.usage?.details?.reasoningOutputTokens
    return {
      "usage.hasCost": event.usageRecord.cost !== undefined,
      "usage.hasRaw": event.usageRecord.raw !== undefined,
      "usage.reasoningTokens": reasoningTokens,
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
  if (!event.data || !hasRuntimeType(event.data, "object")) return
  // SAFETY: Trace normalization establishes the asserted telemetry event contract.
  const data = event.data as { title?: unknown, type?: unknown }
  return data.type === "title" && hasRuntimeType(data.title, "string") && data.title.trim()
    ? data.title.trim()
    : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  // SAFETY: Trace normalization establishes the asserted telemetry event contract.
  return value && hasRuntimeType(value, "object") && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function dataTraceEvent(event: StreamEvent): TraceEvent | undefined {
  if ((event.type !== "data" && !event.type.startsWith("data-")) || !("data" in event)) return
  if (event.type === "data-agent-plan") {
    return {
      attributes: {
        "step.id": event.id,
        "vitehub.activity.body": event.data,
        "vitehub.activity.kind": "plan",
      },
      name: "agent.plan.updated",
      type: "run",
    }
  }
  if (event.type === "data-agent-diff") {
    const data = record(event.data)
    return {
      attributes: {
        "step.id": event.id,
        "vitehub.activity.body": data?.unifiedDiff ?? event.data,
        "vitehub.activity.kind": "change",
      },
      name: "agent.change.updated",
      type: "run",
    }
  }
  if (event.type !== "data-agent-event") return
  const data = record(event.data)
  const kind = hasRuntimeType(data?.kind, "string") ? data.kind : undefined
  const value = record(data?.value)
  if (kind === "content.delta" && value?.streamKind === "command_output") {
    return {
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.call.id": event.id,
        "step.id": event.id,
        "tool.id": event.id,
        "tool.output": value.delta,
        "vitehub.activity.body": value.delta,
        "vitehub.activity.kind": "tool",
      },
      name: "agent.tool.output",
      type: "run",
    }
  }
  if (kind === "tool.progress" || kind === "tool.summary") {
    return {
      attributes: {
        "step.id": event.id,
        "tool.id": event.id,
        "tool.name": value?.toolName,
        "tool.output": value?.summary ?? data?.value,
        "vitehub.activity.body": value?.summary,
        "vitehub.activity.kind": "tool",
      },
      name: kind === "tool.progress" ? "agent.tool.progress" : "agent.tool.summary",
      type: "run",
    }
  }
  if (kind?.startsWith("task.")) {
    const status = hasRuntimeType(value?.status, "string") ? value.status : undefined
    const outcome = kind === "task.completed"
      ? status === "failed"
        ? "task.failed"
        : status === "stopped"
          ? "task.cancelled"
          : kind
      : kind
    return {
      attributes: {
        "error.message": outcome === "task.failed" && hasRuntimeType(value?.summary, "string") ? value.summary : undefined,
        "step.id": event.id,
        "task.status": status,
        "vitehub.activity.body": data?.value,
        "vitehub.activity.kind": "activity",
        "vitehub.activity.name": outcome,
      },
      name: `agent.${outcome}`,
      type: outcome === "task.failed" ? "error" : "run",
    }
  }
}

export async function traceAgentEvent<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentTraceContext<TRuntimeConfig>,
  event: TraceEvent,
): Promise<void> {
  try {
    const invocationId = context.context.get(agentInvocationTraceIdContextKey)
    const attributes = {
      ...(invocationId ? { "agent.invocation.id": invocationId } : {}),
      ...(context.run?.runId ? { "agent.run.id": context.run.runId } : {}),
      ...event.attributes,
    }
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
    attributes: invocationAttributes(context, {}, true),
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
  // SAFETY: Trace normalization establishes the asserted telemetry event contract.
  if (!event || !hasRuntimeType(event, "object") || !hasRuntimeType((event as { type?: unknown }).type, "string")) return
  // SAFETY: Trace normalization establishes the asserted telemetry event contract.
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
  const dataEvent = dataTraceEvent(streamEvent)
  if (dataEvent) {
    await traceAgentEvent(context, dataEvent)
    return
  }
  // SAFETY: Trace normalization establishes the asserted telemetry event contract.
  const names = {
    "approval-decision": "agent.approval.decision",
    "approval-request": "agent.approval.request",
    error: "agent.stream.error",
    finish: "agent.stream.finish",
    "tool-call": "agent.tool.start",
    "tool-input-start": "agent.tool.start",
    "tool-result": streamEvent.type === "tool-result" && streamEvent.error ? "agent.tool.error" : "agent.tool.finish",
    "text-delta": "agent.message.delta",
    usage: "agent.usage.recorded",
  } as const
  // SAFETY: Trace normalization establishes the asserted telemetry event contract.
  const name = streamEvent.type in names ? names[streamEvent.type as keyof typeof names] : undefined
  if (!name) return

  await traceAgentEvent(context, {
    attributes: eventAttributes(streamEvent),
    name,
    type: streamEvent.type.startsWith("approval") ? "approval" : streamEvent.type === "error" || (streamEvent.type === "tool-result" && streamEvent.error) ? "error" : "run",
  })
}

type AgentDataStreamEvent = StreamEvent & { type: "data-agent-event" }

function isAgentDataStreamEvent(event: StreamEvent): event is AgentDataStreamEvent {
  return event.type === "data-agent-event"
}

export function createAgentStreamEventTracer<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentTraceContext<TRuntimeConfig>,
) {
  let pendingText: Extract<StreamEvent, { type: "text-delta" }> | undefined
  let pendingCommandOutput: AgentDataStreamEvent | undefined
  const flush = async () => {
    const events = [pendingText, pendingCommandOutput]
    pendingText = undefined
    pendingCommandOutput = undefined
    for (const event of events) {
      if (event) await traceAgentStreamEvent(context, event)
    }
  }
  return {
    flush,
    async write(event: StreamEvent) {
      const data = event.type === "data-agent-event" ? record(event.data) : undefined
      const value = record(data?.value)
      if (isAgentDataStreamEvent(event) && data?.kind === "content.delta" && value?.streamKind === "command_output" && hasRuntimeType(value.delta, "string")) {
        const pendingData = pendingCommandOutput ? record(pendingCommandOutput.data) : undefined
        const pendingValue = record(pendingData?.value)
        let remaining = value.delta
        if (pendingCommandOutput && pendingCommandOutput.id === event.id && hasRuntimeType(pendingValue?.delta, "string")) {
          remaining = pendingValue.delta + remaining
          pendingCommandOutput = undefined
        }
        else await flush()
        while (remaining.length > MAX_TRACE_TEXT_EVENT_LENGTH) {
          pendingCommandOutput = { ...event, data: { ...data, value: { ...value, delta: remaining.slice(0, MAX_TRACE_TEXT_EVENT_LENGTH) } } }
          remaining = remaining.slice(MAX_TRACE_TEXT_EVENT_LENGTH)
          await flush()
        }
        pendingCommandOutput = { ...event, data: { ...data, value: { ...value, delta: remaining } } }
        return
      }
      if (event.type !== "text-delta" || !hasRuntimeType(event.text, "string")) {
        await flush()
        await traceAgentStreamEvent(context, event)
        return
      }
      if (pendingText
        && pendingText.id === event.id
        && pendingText.messageId === event.messageId
        && pendingText.phase === event.phase
        && pendingText.role === event.role) {
        let remaining = event.text
        while (pendingText && pendingText.text.length + remaining.length > MAX_TRACE_TEXT_EVENT_LENGTH) {
          const length = MAX_TRACE_TEXT_EVENT_LENGTH - pendingText.text.length
          pendingText = { ...pendingText, text: pendingText.text + remaining.slice(0, length) }
          remaining = remaining.slice(length)
          await flush()
          pendingText = { ...event, text: "" }
        }
        pendingText = { ...pendingText, text: pendingText.text + remaining }
        return
      }
      await flush()
      let remaining = event.text
      while (remaining.length > MAX_TRACE_TEXT_EVENT_LENGTH) {
        pendingText = { ...event, text: remaining.slice(0, MAX_TRACE_TEXT_EVENT_LENGTH) }
        remaining = remaining.slice(MAX_TRACE_TEXT_EVENT_LENGTH)
        await flush()
      }
      pendingText = { ...event, text: remaining }
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
      // SAFETY: Trace normalization establishes the asserted telemetry event contract.
      yield event as StreamEvent
    }
  })()
}

function valueFromPath(value: unknown, path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!current || !hasRuntimeType(current, "object")) return undefined
    // SAFETY: Trace normalization establishes the asserted telemetry event contract.
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => hasRuntimeType(value, "string") && value.length > 0)
}

export function aiSdkTelemetryIntegration<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentTraceContext<TRuntimeConfig>,
  toolActivities?: ReadonlyMap<string, AgentActivity>,
): Telemetry {
  const modelAttributes = (event: unknown) => ({
    "model.id": firstString(valueFromPath(event, ["model", "modelId"]), valueFromPath(event, ["model", "id"]), valueFromPath(event, ["modelId"])),
    "model.provider": firstString(valueFromPath(event, ["model", "provider"]), valueFromPath(event, ["provider"])),
    "model.call.id": firstString(valueFromPath(event, ["id"]), valueFromPath(event, ["callId"]), valueFromPath(event, ["requestId"])) || "model",
  })
  const toolAttributes = (event: unknown) => {
    const name = firstString(valueFromPath(event, ["toolCall", "toolName"]), valueFromPath(event, ["toolName"]), valueFromPath(event, ["name"]), valueFromPath(event, ["tool", "name"]))
    const activity = name ? toolActivities?.get(name) : undefined
    return {
      "step.id": firstString(valueFromPath(event, ["toolCall", "toolCallId"]), valueFromPath(event, ["toolCallId"]), valueFromPath(event, ["id"]), valueFromPath(event, ["tool", "id"])) || "tool",
      "tool.id": firstString(valueFromPath(event, ["toolCall", "toolCallId"]), valueFromPath(event, ["toolCallId"]), valueFromPath(event, ["id"]), valueFromPath(event, ["tool", "id"])),
      "tool.name": name,
      "vitehub.action.name": activity?.kind === "action" ? activity.name : undefined,
      "vitehub.activity.kind": activity?.kind || "tool",
    }
  }

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
          "error.message": error instanceof Error ? error.message : hasRuntimeType(error, "string") ? error : undefined,
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
