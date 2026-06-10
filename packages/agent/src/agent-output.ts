import { ApprovalRequiredError } from "@vite-hub/runtime"

import type { StreamEvent } from "./messages.ts"
import type { AgentRunResult, AgentUsageRecord } from "./types.ts"

export function toAgentRunResult(value: unknown): AgentRunResult {
  if (typeof value !== "object" || value === null) {
    return { raw: value, text: typeof value === "string" ? value : undefined }
  }

  const result = value as Record<string, unknown>
  return {
    finishReason: result.finishReason,
    raw: value,
    text: typeof result.text === "string" ? result.text : undefined,
    usage: result.usage,
    usageRecord: result.usageRecord as AgentUsageRecord | undefined,
    warnings: result.warnings,
  }
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value
}

export function toAgentStreamEvent(chunk: unknown, toolNames?: Map<string, string>): StreamEvent | undefined {
  if (typeof chunk === "string") {
    return { text: chunk, type: "text-delta" }
  }
  if (!chunk || typeof chunk !== "object") {
    return undefined
  }

  const value = chunk as Record<string, unknown>
  const type = String(value.type || "")
  if (type === "text-delta" || type === "text") {
    return { id: value.id as string | undefined, text: String(value.text || value.textDelta || value.delta || ""), type: "text-delta" }
  }
  if (type === "data") {
    return { data: value.data, id: value.id as string | undefined, messageId: value.messageId as string | undefined, type: "data" }
  }
  if (type === "tool-input-start") {
    const id = String(value.id || value.toolCallId)
    const name = String(value.toolName || value.name || toolNames?.get(id) || "tool")
    toolNames?.set(id, name)
    return { id, input: value.input, name, type: "tool-input-start" }
  }
  if (type === "tool-call" || type === "tool-input-available") {
    const id = String(value.toolCallId ?? value.id)
    const name = String(value.toolName ?? value.name ?? toolNames?.get(id) ?? "tool")
    toolNames?.set(id, name)
    return { id, input: value.input ?? value.args, name, type: "tool-call" }
  }
  if (type === "tool-result" || type === "tool-output-available") {
    const id = String(value.toolCallId ?? value.id)
    return { error: typeof value.error === "string" ? value.error : undefined, id, name: String(value.toolName ?? value.name ?? toolNames?.get(id) ?? "tool"), output: value.output ?? value.result, type: "tool-result" }
  }
  if (type === "tool-error" || type === "tool-output-error") {
    const id = String(value.toolCallId ?? value.id)
    const error = value.error instanceof Error
      ? value.error.message
      : typeof value.errorText === "string"
        ? value.errorText
        : String(value.error || "Unknown tool error")
    return { error, id, name: String(value.toolName ?? value.name ?? toolNames?.get(id) ?? "tool"), output: value.output ?? value.result, type: "tool-result" }
  }
  if (type === "error") {
    if (value.error instanceof ApprovalRequiredError) {
      const { request } = value.error
      return { id: request.id, input: request.input, name: request.capability || request.id, reason: request.reason, type: "approval-request" }
    }
    return { error: value.error instanceof Error ? value.error.message : String(value.error || "Unknown error"), type: "error" }
  }
  if (type === "finish") {
    return { reason: typeof value.finishReason === "string" ? value.finishReason : undefined, type: "finish" }
  }
  return undefined
}

export async function* streamAgentOutputToEvents(value: unknown): AsyncIterable<StreamEvent> {
  if (typeof value === "string") {
    if (value) yield { text: value, type: "text-delta" }
    yield { type: "finish" }
    return
  }
  if (isAsyncIterable(value)) {
    const toolNames = new Map<string, string>()
    for await (const chunk of value as AsyncIterable<unknown>) {
      const event = toAgentStreamEvent(chunk, toolNames)
      if (event) yield event
    }
    return
  }
  const result = value as { fullStream?: AsyncIterable<unknown>, textStream?: AsyncIterable<string> }
  if (result.fullStream) {
    const toolNames = new Map<string, string>()
    for await (const chunk of result.fullStream) {
      const event = toAgentStreamEvent(chunk, toolNames)
      if (event) yield event
    }
    return
  }
  if (result.textStream) {
    for await (const text of result.textStream) {
      yield { text, type: "text-delta" }
    }
    return
  }
  if (typeof (value as { text?: unknown } | undefined)?.text === "string") {
    const text = (value as { text: string }).text
    if (text) yield { text, type: "text-delta" }
    yield {
      reason: typeof (value as { finishReason?: unknown }).finishReason === "string"
        ? (value as { finishReason: string }).finishReason
        : undefined,
      type: "finish",
    }
  }
}
