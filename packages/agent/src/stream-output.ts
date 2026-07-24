import { isAsyncIterable } from "./internal/stream-result.ts"
import { usageRecordFromStreamChunk } from "./agent-output.ts"

import type { AgentUIMessageStreamProjection, AgentUsageRecord, MaybePromise } from "./types.ts"

interface FinalizedStreamOutput<T> {
  deferFinish: boolean
  finishResult: unknown
  value: ReadableStream<T>
}

interface AgentUIMessageStreamWriter {
  write(event: unknown): void
}

type StreamCleanupOutcome =
  | { failed: false }
  | { error: unknown, failed: true }

const uiMessageStreamHeaders = {
  "cache-control": "no-cache",
  connection: "keep-alive",
  "content-type": "text/event-stream",
  "x-accel-buffering": "no",
  "x-vercel-ai-ui-message-stream": "v1",
} as const

export function isUIMessageStreamResult(value: unknown): value is { toUIMessageStream: () => ReadableStream<unknown> } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { toUIMessageStream?: unknown }).toUIMessageStream === "function"
}

export function createAgentUIMessageStream(options: {
  execute: (context: { writer: AgentUIMessageStreamWriter }) => MaybePromise<void>
}): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    start(controller) {
      const writer: AgentUIMessageStreamWriter = {
        write(event) {
          try {
            controller.enqueue(event)
          }
          catch {
            // The consumer may cancel the response before the agent finishes.
          }
        },
      }
      void Promise.resolve(options.execute({ writer }))
        .catch((error) => {
          try {
            controller.enqueue({
              errorText: error instanceof Error ? error.message : "Agent stream failed.",
              type: "error",
            })
          }
          catch {}
        })
        .finally(() => {
          try {
            controller.close()
          }
          catch {}
        })
    },
  })
}

export function createAgentUIMessageStreamResponse(options: {
  headers?: ConstructorParameters<typeof Headers>[0]
  status?: number
  statusText?: string
  stream: ReadableStream<unknown>
}): Response {
  const headers = new Headers(options.headers)
  for (const [key, value] of Object.entries(uiMessageStreamHeaders)) {
    if (!headers.has(key)) headers.set(key, value)
  }
  const encoder = new TextEncoder()
  const stream = options.stream.pipeThrough(new TransformStream<unknown, Uint8Array>({
    flush(controller) {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
    },
    transform(part, controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(part)}\n\n`))
    },
  }))
  return new Response(stream, {
    headers,
    status: options.status,
    statusText: options.statusText,
  })
}

export function withReadableStreamCleanup<T>(
  stream: ReadableStream<T>,
  cleanup: (outcome: StreamCleanupOutcome) => Promise<void>,
  options: { onChunk?: (chunk: T) => void } = {},
): ReadableStream<T> {
  const reader = stream.getReader()
  let cleaned = false
  const runCleanup = async (outcome: StreamCleanupOutcome = { failed: false }) => {
    if (cleaned) return
    cleaned = true
    await cleanup(outcome)
  }
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          await runCleanup()
          controller.close()
          return
        }
        options.onChunk?.(result.value)
        controller.enqueue(result.value)
      }
      catch (error) {
        await runCleanup({ error, failed: true })
        controller.error(error)
      }
    },
    async cancel(reason) {
      let outcome: StreamCleanupOutcome = reason === undefined ? { failed: false } : { error: reason, failed: true }
      try {
        await reader.cancel(reason)
      }
      catch (error) {
        outcome = { error, failed: true }
        throw error
      }
      finally {
        await runCleanup(outcome)
      }
    },
  })
}

function textFromRenderedOutput(rendered: unknown): string | undefined {
  if (typeof rendered === "string") return rendered
  if (typeof rendered !== "object" || rendered === null) return undefined
  const record = rendered as { text?: unknown }
  return typeof record.text === "string" ? record.text : undefined
}

function streamEventType(event: unknown): string | undefined {
  return typeof event === "object" && event !== null && typeof (event as { type?: unknown }).type === "string"
    ? (event as { type: string }).type
    : undefined
}

export function uiMessageTextDelta(event: unknown): string | undefined {
  const type = streamEventType(event)
  if (type !== "text" && type !== "text-delta") return
  const text = (event as { delta?: unknown, text?: unknown, textDelta?: unknown }).text
    ?? (event as { delta?: unknown, textDelta?: unknown }).textDelta
    ?? (event as { delta?: unknown }).delta
  return typeof text === "string" ? text : undefined
}

function isCapabilityCliInput(input: unknown): input is { argv: string[], input?: unknown, json?: boolean } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  const argv = record.argv
  return Object.keys(record).every(key => key === "argv" || key === "input" || key === "json")
    && Array.isArray(argv)
    && argv.every(arg => typeof arg === "string")
    && (record.json === undefined || typeof record.json === "boolean")
}

function normalizeUiMessageStreamChunk(chunk: unknown): unknown {
  if (typeof chunk !== "object" || chunk === null) return chunk
  const record = chunk as Record<string, unknown>
  if (record.type !== "tool-input-error") return chunk
  const metadata = typeof record.toolMetadata === "object" && record.toolMetadata !== null
    ? record.toolMetadata as Record<string, unknown>
    : undefined
  if (metadata?.vitehubCapabilityCli !== true || !isCapabilityCliInput(record.input)) return chunk

  const { errorText: _errorText, ...available } = record
  return { ...available, type: "tool-input-available" }
}

export function normalizeUiMessageStream(stream: ReadableStream<unknown>): ReadableStream<unknown> {
  return stream.pipeThrough(new TransformStream<unknown, unknown>({
    transform(chunk, controller) {
      controller.enqueue(normalizeUiMessageStreamChunk(chunk))
    },
  }))
}

function projectUiMessageStream(
  stream: ReadableStream<unknown>,
  projection: AgentUIMessageStreamProjection | undefined,
): ReadableStream<unknown> {
  if (!projection) return stream
  return stream.pipeThrough(new TransformStream<unknown, unknown>({
    transform(chunk, controller) {
      const type = streamEventType(chunk)
      if (projection.reasoning === "hidden" && type?.startsWith("reasoning-")) return
      if (projection.tools === "hidden" && type?.startsWith("tool-")) return
      controller.enqueue(chunk)
    },
  }))
}

function uiDataType(data: unknown): `data-${string}` {
  const rawType = typeof data === "object" && data !== null && typeof (data as { type?: unknown }).type === "string"
    ? (data as { type: string }).type
    : "event"
  const type = rawType.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return `data-${type || "event"}`
}

async function writeEventsToUiMessageStream(
  writer: AgentUIMessageStreamWriter,
  events: AsyncIterable<unknown>,
  options: { onUsageRecord?: (usageRecord: AgentUsageRecord) => void } = {},
) {
  const messageId = crypto.randomUUID()
  let textStarted = false
  let finished = false
  writer.write({ type: "start", messageId })
  for await (const event of events) {
    const usageRecord = usageRecordFromStreamChunk(event, events)
    if (usageRecord) options.onUsageRecord?.(usageRecord)
    const type = streamEventType(event)
    if (!type) continue
    if (type === "text-delta") {
      const text = (event as { delta?: unknown, text?: unknown }).text ?? (event as { delta?: unknown }).delta
      if (typeof text !== "string" || !text) continue
      if (!textStarted) {
        writer.write({ type: "text-start", id: messageId })
        textStarted = true
      }
      writer.write({ type: "text-delta", id: messageId, delta: text })
      continue
    }
    if (type === "tool-call") {
      const tool = event as { id?: unknown, input?: unknown, name?: unknown }
      writer.write({ type: "tool-input-available", toolCallId: tool.id, toolName: tool.name, input: tool.input })
      continue
    }
    if (type === "tool-result") {
      const tool = event as { error?: unknown, id?: unknown, name?: unknown, output?: unknown }
      if (typeof tool.error === "string") {
        writer.write({ type: "tool-output-error", toolCallId: tool.id, toolName: tool.name, errorText: tool.error })
        continue
      }
      writer.write({ type: "tool-output-available", toolCallId: tool.id, toolName: tool.name, output: tool.output })
      continue
    }
    if (type === "data" || type.startsWith("data-")) {
      const dataEvent = event as { data?: unknown, id?: unknown, transient?: unknown }
      writer.write({ type: type === "data" ? uiDataType(dataEvent.data) : type, data: dataEvent.data, id: dataEvent.id, ...(typeof dataEvent.transient === "boolean" ? { transient: dataEvent.transient } : {}) })
      continue
    }
    if (type === "finish") {
      finished = true
      break
    }
    if (type === "error") {
      const error = event as { error?: unknown, message?: unknown }
      throw error.error || new Error(typeof error.message === "string" ? error.message : "Agent stream failed.")
    }
  }
  if (textStarted) writer.write({ type: "text-end", id: messageId })
  writer.write({ type: "finish", finishReason: finished ? "stop" : "unknown" })
}

export async function finalizeUiMessageStreamOutput(
  rendered: unknown,
  shouldWrapOutput: boolean,
  finish: (outcome: StreamCleanupOutcome, streamedText?: string, streamedUsageRecord?: AgentUsageRecord) => MaybePromise<void>,
  projection?: AgentUIMessageStreamProjection,
): Promise<FinalizedStreamOutput<unknown>> {
  const hasUiMessageStream = isUIMessageStreamResult(rendered)
  const hasAsyncIterable = isAsyncIterable(rendered)
  const text = hasUiMessageStream || hasAsyncIterable ? undefined : textFromRenderedOutput(rendered)
  if (!hasUiMessageStream && !hasAsyncIterable && text === undefined) {
    throw new Error("[vitehub] Agent stream output \"ui-message-stream\" requires a result with toUIMessageStream().")
  }
  let streamedUsageRecord: AgentUsageRecord | undefined
  const stream = projectUiMessageStream(normalizeUiMessageStream(hasUiMessageStream
    ? rendered.toUIMessageStream()
    : hasAsyncIterable
      ? createAgentUIMessageStream({
          execute: async ({ writer }) => await writeEventsToUiMessageStream(writer, rendered, {
            onUsageRecord: usageRecord => { streamedUsageRecord = usageRecord },
          }),
        })
      : createAgentUIMessageStream({
        execute({ writer }) {
          const messageId = crypto.randomUUID()
          writer.write({ type: "start", messageId })
          writer.write({ type: "text-start", id: messageId })
          writer.write({ type: "text-delta", id: messageId, delta: text || "" })
          writer.write({ type: "text-end", id: messageId })
          writer.write({ type: "finish", finishReason: "stop" })
        },
  })), projection)
  let streamedText = ""
  return {
    deferFinish: shouldWrapOutput,
    finishResult: rendered,
    value: shouldWrapOutput
      ? withReadableStreamCleanup(stream, outcome => Promise.resolve(finish(outcome, streamedText, streamedUsageRecord)), {
          onChunk(chunk) {
            streamedText += uiMessageTextDelta(chunk) || ""
            streamedUsageRecord = usageRecordFromStreamChunk(chunk, rendered) ?? streamedUsageRecord
          },
        })
      : stream,
  }
}
