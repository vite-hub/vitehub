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
  | { completed?: boolean, failed: false }
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

export function isUIMessageStreamResponse(value: unknown): value is Response & { body: ReadableStream<Uint8Array> } {
  return value instanceof Response
    && value.body !== null
    && value.headers.get("x-vercel-ai-ui-message-stream") === "v1"
}

export function uiMessageStreamFromResponse(response: Response & { body: ReadableStream<Uint8Array> }): ReadableStream<unknown> {
  const decoder = new TextDecoder()
  let buffer = ""
  const enqueueFrames = (controller: TransformStreamDefaultController<unknown>, flush = false) => {
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = flush ? "" : frames.pop() || ""
    for (const frame of frames) {
      const data = frame.split(/\r?\n/)
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart())
        .join("\n")
      if (!data || data === "[DONE]") continue
      controller.enqueue(JSON.parse(data))
    }
  }
  return response.body.pipeThrough(new TransformStream<Uint8Array, unknown>({
    flush(controller) {
      buffer += decoder.decode()
      if (buffer.trim()) buffer += "\n\n"
      enqueueFrames(controller, true)
    },
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      enqueueFrames(controller)
    },
  }))
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
  options: { abortSignal?: AbortSignal, onChunk?: (chunk: T) => void } = {},
): ReadableStream<T> {
  const reader = stream.getReader()
  let cleaned = false
  let wrappedController: ReadableStreamDefaultController<T> | undefined
  const runCleanup = async (outcome: StreamCleanupOutcome = { completed: true, failed: false }) => {
    if (cleaned) return
    cleaned = true
    options.abortSignal?.removeEventListener("abort", onAbort)
    await cleanup(outcome)
  }
  const onAbort = () => {
    const reason = options.abortSignal?.reason ?? new DOMException("[vitehub] Agent Invocation stream aborted.", "AbortError")
    if (cleaned) return
    cleaned = true
    options.abortSignal?.removeEventListener("abort", onAbort)
    wrappedController?.error(reason)
    void Promise.allSettled([reader.cancel(reason), cleanup({ error: reason, failed: true })])
  }
  const wrapped = new ReadableStream<T>({
    start(controller) {
      wrappedController = controller
    },
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
      let outcome: StreamCleanupOutcome = reason === undefined ? { completed: false, failed: false } : { error: reason, failed: true }
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
  if (options.abortSignal?.aborted) onAbort()
  else options.abortSignal?.addEventListener("abort", onAbort, { once: true })
  return wrapped
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

export function normalizeUiMessageStreamChunk(chunk: unknown): unknown {
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
  const pendingTextStarts = new Map<string, unknown>()
  const reasoningTextIds = new Set<string>()
  return stream.pipeThrough(new TransformStream<unknown, unknown>({
    flush(controller) {
      for (const start of pendingTextStarts.values()) controller.enqueue(start)
    },
    transform(chunk, controller) {
      const type = streamEventType(chunk)
      if (projection.reasoning === "hidden") {
        if (type?.startsWith("reasoning-")) return
        const text = chunk as { id?: unknown, phase?: unknown }
        const id = typeof text.id === "string" ? text.id : undefined
        if (type === "text-start" && id) {
          reasoningTextIds.delete(id)
          pendingTextStarts.delete(id)
          if (text.phase === "reasoning") {
            reasoningTextIds.add(id)
            return
          }
          pendingTextStarts.set(id, chunk)
          return
        }
        if (text.phase === "reasoning" && id) {
          pendingTextStarts.delete(id)
          reasoningTextIds.add(id)
        }
        const reasoning = text.phase === "reasoning" || Boolean(id && reasoningTextIds.has(id))
        if (type === "text-end" && id) reasoningTextIds.delete(id)
        if (reasoning) return
        if (id && pendingTextStarts.has(id)) {
          controller.enqueue(pendingTextStarts.get(id))
          pendingTextStarts.delete(id)
        }
      }
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
  options: {
    onUsageRecord?: (usageRecord: AgentUsageRecord) => void
    projection?: AgentUIMessageStreamProjection
  } = {},
) {
  const messageId = crypto.randomUUID()
  let textStarted = false
  let finished = false
  const reasoningTextIds = new Set<string>()
  writer.write({ type: "start", messageId })
  for await (const event of events) {
    const usageRecord = usageRecordFromStreamChunk(event, events)
    if (usageRecord) options.onUsageRecord?.(usageRecord)
    const type = streamEventType(event)
    if (!type) continue
    if (options.projection?.reasoning === "hidden") {
      const text = event as { id?: unknown, phase?: unknown }
      const id = typeof text.id === "string" ? text.id : undefined
      if (type === "text-start" && id) {
        reasoningTextIds.delete(id)
      }
      if (text.phase === "reasoning" && id) reasoningTextIds.add(id)
      const reasoning = type.startsWith("reasoning-")
        || text.phase === "reasoning"
        || Boolean(id && reasoningTextIds.has(id))
      if (type === "text-end" && id) reasoningTextIds.delete(id)
      if (reasoning) continue
    }
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
  abortSignal?: AbortSignal,
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
            projection,
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
          abortSignal,
          onChunk(chunk) {
            streamedText += uiMessageTextDelta(chunk) || ""
            streamedUsageRecord = usageRecordFromStreamChunk(chunk, rendered) ?? streamedUsageRecord
          },
        })
      : stream,
  }
}
