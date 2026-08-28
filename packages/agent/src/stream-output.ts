import { isAsyncIterable } from "./internal/stream-result.ts"
import { hasRuntimeType } from "./internal/runtime-type.ts"
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
  return hasRuntimeType(value, "object") && value !== null
    && hasRuntimeType(Reflect.get(value, "toUIMessageStream"), "function")
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
  execute: (context: { abortSignal: AbortSignal, writer: AgentUIMessageStreamWriter }) => MaybePromise<void>
}): ReadableStream<unknown> {
  const cancellation = new AbortController()
  let execution: Promise<void> | undefined
  return new ReadableStream<unknown>({
    cancel(reason) {
      cancellation.abort(reason ?? new DOMException("[vitehub] Agent UI-message stream cancelled.", "AbortError"))
      return execution
    },
    pull(controller) {
      if (execution) return execution
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
      execution = Promise.resolve(options.execute({ abortSignal: cancellation.signal, writer }))
        .catch((error) => {
          try {
            controller.enqueue({
              error,
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
      return execution
    },
  }, { highWaterMark: 0 })
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

export function cancellableAsyncIterableSource(stream: AsyncIterable<unknown>, options: { deferReader?: boolean } = {}): {
  cancel: (reason?: unknown) => Promise<void>
  stream: AsyncIterable<unknown>
} {
  const directCancel = hasRuntimeType(stream, "object")
    ? Reflect.get(stream, Symbol.for("vitehub.agent.stream.cancel"))
    : undefined
  const getReader = Reflect.get(stream, "getReader")
  let readableReader: ReadableStreamDefaultReader<unknown> | undefined
  let iterator: AsyncIterator<unknown> | undefined
  const getIterator = (): AsyncIterator<unknown> => {
    if (iterator) return iterator
    readableReader = hasRuntimeType(getReader, "function")
      // SAFETY: A callable getReader member establishes the ReadableStream-like boundary used here.
      ? (getReader as (this: AsyncIterable<unknown>) => ReadableStreamDefaultReader<unknown>).call(stream)
      : undefined
    iterator = readableReader
      ? {
          next: () => readableReader!.read(),
          async return(reason) {
            try {
              await readableReader!.cancel(reason)
            }
            finally {
              readableReader!.releaseLock()
            }
            return { done: true, value: undefined }
          },
        }
      : stream[Symbol.asyncIterator]()
    return iterator
  }
  if (!options.deferReader) getIterator()
  let cancelTask: Promise<void> | undefined
  let completed = false
  const cancel = async (reason?: unknown) => {
    if (completed) return
    cancelTask ||= (async () => {
      if (hasRuntimeType(directCancel, "function")) directCancel(reason)
      await getIterator().return?.(reason)
    })()
    await cancelTask
  }
  const source = (async function* () {
    try {
      for (;;) {
        const chunk = await getIterator().next()
        if (chunk.done) {
          completed = true
          return
        }
        yield chunk.value
      }
    }
    finally {
      if (!completed) await cancel()
      else readableReader?.releaseLock()
    }
  })()
  Object.defineProperty(source, Symbol.for("vitehub.agent.stream.cancel"), { value: cancel })
  return { cancel, stream: source }
}

export function withReadableStreamCleanup<T>(
  stream: ReadableStream<T>,
  cleanup: (outcome: StreamCleanupOutcome) => Promise<void>,
  options: { abortSignal?: AbortSignal, cancelOnAbort?: (reason: unknown) => Promise<void>, onChunk?: (chunk: T) => void } = {},
): ReadableStream<T> {
  const reader = stream.getReader()
  let cleaned = false
  let pendingError: unknown
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
    void (async () => {
      let outcome: StreamCleanupOutcome = { error: reason, failed: true }
      try {
        await options.cancelOnAbort?.(reason)
        await reader.cancel(reason)
      }
      catch (error) {
        outcome = { error, failed: true }
      }
      await cleanup(outcome)
    })().catch(() => {})
  }
  const wrapped = new ReadableStream<T>({
    start(controller) {
      wrappedController = controller
    },
    async pull(controller) {
      if (pendingError !== undefined) {
        controller.error(pendingError)
        return
      }
      try {
        const result = await reader.read()
        if (result.done) {
          await runCleanup()
          controller.close()
          return
        }
        const error = uiMessageStreamError(result.value)
        options.onChunk?.(result.value)
        controller.enqueue(result.value)
        if (error) {
          await Promise.allSettled([
            options.cancelOnAbort?.(error),
            reader.cancel(error),
          ].filter((task): task is Promise<void> => task !== undefined))
          await runCleanup({ error, failed: true })
          pendingError = error
        }
      }
      catch (error) {
        await Promise.allSettled([
          options.cancelOnAbort?.(error),
          reader.cancel(error),
        ].filter((task): task is Promise<void> => task !== undefined))
        await runCleanup({ error, failed: true })
        controller.error(error)
      }
    },
    async cancel(reason) {
      let outcome: StreamCleanupOutcome = reason === undefined ? { completed: false, failed: false } : { error: reason, failed: true }
      try {
        await options.cancelOnAbort?.(reason)
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
  }, { highWaterMark: 0 })
  if (options.abortSignal?.aborted) onAbort()
  else options.abortSignal?.addEventListener("abort", onAbort, { once: true })
  return wrapped
}

function textFromRenderedOutput(rendered: unknown): string | undefined {
  if (hasRuntimeType(rendered, "string")) return rendered
  if (!hasRuntimeType(rendered, "object") || rendered === null) return undefined
  const text = Reflect.get(rendered, "text")
  return hasRuntimeType(text, "string") ? text : undefined
}

function streamEventType(event: unknown): string | undefined {
  if (!hasRuntimeType(event, "object") || event === null) return
  const type = Reflect.get(event, "type")
  return hasRuntimeType(type, "string") ? type : undefined
}

export function uiMessageTextDelta(event: unknown): string | undefined {
  const type = streamEventType(event)
  if (type !== "text" && type !== "text-delta") return
  if (!hasRuntimeType(event, "object") || event === null) return
  const text = Reflect.get(event, "text") ?? Reflect.get(event, "textDelta") ?? Reflect.get(event, "delta")
  return hasRuntimeType(text, "string") ? text : undefined
}

function uiMessageStreamError(event: unknown): Error | undefined {
  if (streamEventType(event) !== "error" || !hasRuntimeType(event, "object")) return
  // SAFETY: The error event tag establishes the provider error wire representation read below.
  const error = event as { error?: unknown, errorText?: unknown, message?: unknown, recoverable?: unknown }
  if (error.recoverable === true) return
  if (error.error instanceof Error) return error.error
  const message = error.errorText ?? error.message ?? error.error
  return new Error(hasRuntimeType(message, "string") && message ? message : "Agent stream failed.")
}

function isCapabilityCliInput(input: unknown): input is { argv: string[], input?: unknown, json?: boolean } {
  if (!hasRuntimeType(input, "object") || input === null || Array.isArray(input)) return false
  // SAFETY: The object boundary above permits inspecting the candidate CLI record.
  const record = input as Record<string, unknown>
  const argv = record.argv
  return Object.keys(record).every(key => key === "argv" || key === "input" || key === "json")
    && Array.isArray(argv)
    && argv.every(arg => hasRuntimeType(arg, "string"))
    && (record.json === undefined || hasRuntimeType(record.json, "boolean"))
}

export function normalizeUiMessageStreamChunk(chunk: unknown): unknown {
  if (!hasRuntimeType(chunk, "object") || chunk === null) return chunk
  // SAFETY: The object boundary above permits inspecting the provider chunk record.
  const record = chunk as Record<string, unknown>
  if (record.type === "error" && record.recoverable === true) {
    const error = record.errorText ?? record.message ?? record.error
    return {
      data: {
        error: error instanceof Error ? error.message : String(error || "Agent stream encountered a recoverable error."),
        recoverable: true,
        type: "error",
      },
      type: "data-error",
    }
  }
  if (record.type !== "tool-input-error") return chunk
  const metadata = hasRuntimeType(record.toolMetadata, "object")
    // SAFETY: The runtime object check establishes the metadata record representation.
    ? record.toolMetadata as Record<string, unknown>
    : undefined
  if (metadata?.vitehubCapabilityCli !== true || !isCapabilityCliInput(record.input)) return chunk

  const { errorText: _errorText, ...available } = record
  return { ...available, type: "tool-input-available" }
}

export function normalizeUiMessageStream(
  stream: ReadableStream<unknown>,
  options: {
    omitUsageEvents?: boolean
    onChunk?: (chunk: unknown) => void
    onUsageRecord?: (usageRecord: AgentUsageRecord) => void
  } = {},
): ReadableStream<unknown> {
  return stream.pipeThrough(new TransformStream<unknown, unknown>({
    transform(chunk, controller) {
      const usageRecord = usageRecordFromStreamChunk(chunk, stream)
      if (usageRecord) options.onUsageRecord?.(usageRecord)
      if (options.omitUsageEvents && streamEventType(chunk) === "usage" && usageRecord) return
      const normalized = normalizeUiMessageStreamChunk(chunk)
      options.onChunk?.(normalized)
      controller.enqueue(normalized)
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
        // SAFETY: streamEventType established that this provider chunk uses a tagged stream representation.
        const text = chunk as { id?: unknown, phase?: unknown }
        const id = hasRuntimeType(text.id, "string") ? text.id : undefined
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
  const candidate = hasRuntimeType(data, "object") && data !== null ? Reflect.get(data, "type") : undefined
  const rawType = hasRuntimeType(candidate, "string") ? candidate : "event"
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
  let finishReason = "unknown"
  const reasoningTextIds = new Set<string>()
  writer.write({ type: "start", messageId })
  for await (const event of events) {
    const usageRecord = usageRecordFromStreamChunk(event, events)
    if (usageRecord) options.onUsageRecord?.(usageRecord)
    const type = streamEventType(event)
    if (!type) continue
    if (type === "usage" && usageRecord) continue
    if (options.projection?.reasoning === "hidden") {
      // SAFETY: streamEventType established that this provider event uses a tagged stream representation.
      const text = event as { id?: unknown, phase?: unknown }
      const id = hasRuntimeType(text.id, "string") ? text.id : undefined
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
      const text = uiMessageTextDelta(event)
      if (!text) continue
      if (!textStarted) {
        writer.write({ type: "text-start", id: messageId })
        textStarted = true
      }
      writer.write({ type: "text-delta", id: messageId, delta: text })
      continue
    }
    if (type === "tool-call") {
      // SAFETY: The tool-call event tag establishes the provider tool-call wire representation.
      const tool = event as { id?: unknown, input?: unknown, name?: unknown }
      writer.write({ type: "tool-input-available", toolCallId: tool.id, toolName: tool.name, input: tool.input })
      continue
    }
    if (type === "tool-input-start") {
      // SAFETY: The tool-input-start event tag establishes the provider tool-start wire representation.
      const tool = event as { id?: unknown, name?: unknown }
      writer.write({ type: "tool-input-start", toolCallId: tool.id, toolName: tool.name })
      continue
    }
    if (type === "approval-request") {
      // SAFETY: The approval-request event tag establishes the ViteHub approval wire representation.
      const approval = event as { id?: unknown, input?: unknown, name?: unknown, toolCallId?: unknown }
      const toolCallId = hasRuntimeType(approval.toolCallId, "string") ? approval.toolCallId : approval.id
      if (!hasRuntimeType(approval.toolCallId, "string")) {
        writer.write({ type: "tool-input-available", toolCallId, toolName: approval.name, input: approval.input })
      }
      writer.write({
        approvalId: approval.id,
        toolCallId,
        type: "tool-approval-request",
      })
      continue
    }
    if (type === "approval-decision") {
      // SAFETY: The approval-decision event tag establishes the ViteHub approval response representation.
      const approval = event as { approved?: unknown, id?: unknown, reason?: unknown }
      writer.write({
        approvalId: approval.id,
        approved: approval.approved === true,
        ...(hasRuntimeType(approval.reason, "string") ? { reason: approval.reason } : {}),
        type: "tool-approval-response",
      })
      continue
    }
    if (type === "tool-result") {
      // SAFETY: The tool-result event tag establishes the provider tool-result wire representation.
      const tool = event as { error?: unknown, id?: unknown, name?: unknown, output?: unknown }
      if (hasRuntimeType(tool.error, "string")) {
        writer.write({ type: "tool-output-error", toolCallId: tool.id, toolName: tool.name, errorText: tool.error })
        continue
      }
      writer.write({ type: "tool-output-available", toolCallId: tool.id, toolName: tool.name, output: tool.output })
      continue
    }
    if (type === "data" || type.startsWith("data-")) {
      // SAFETY: The data event tag establishes the provider data-event wire representation.
      const dataEvent = event as { data?: unknown, id?: unknown, transient?: unknown }
      writer.write({ type: type === "data" ? uiDataType(dataEvent.data) : type, data: dataEvent.data, id: dataEvent.id, ...(hasRuntimeType(dataEvent.transient, "boolean") ? { transient: dataEvent.transient } : {}) })
      continue
    }
    if (type === "finish") {
      finished = true
      const reason = hasRuntimeType(event, "object") && event !== null ? Reflect.get(event, "reason") : undefined
      finishReason = hasRuntimeType(reason, "string") ? reason : "stop"
      break
    }
    if (type === "error") {
      // SAFETY: The error event tag establishes the provider error wire representation.
      const error = event as { error?: unknown, message?: unknown, recoverable?: unknown }
      if (error.recoverable === true) {
        writer.write(normalizeUiMessageStreamChunk(event))
        continue
      }
      throw error.error instanceof Error
        ? error.error
        : new Error(hasRuntimeType(error.error, "string") ? error.error : hasRuntimeType(error.message, "string") ? error.message : "Agent stream failed.")
    }
  }
  if (textStarted) writer.write({ type: "text-end", id: messageId })
  writer.write({ type: "finish", finishReason: finished ? finishReason : "unknown" })
}

export async function finalizeUiMessageStreamOutput(
  rendered: unknown,
  shouldWrapOutput: boolean,
  finish: (outcome: StreamCleanupOutcome, streamedText?: string, streamedUsageRecord?: AgentUsageRecord) => MaybePromise<void>,
  options: {
    abortSignal?: AbortSignal
    cancelOnAbort?: (reason: unknown) => Promise<void>
    onNormalizedChunk?: (chunk: unknown) => void
    projection?: AgentUIMessageStreamProjection
  } = {},
): Promise<FinalizedStreamOutput<unknown>> {
  const { abortSignal, cancelOnAbort, onNormalizedChunk, projection } = options
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
          execute: async ({ abortSignal, writer }) => {
            const iterator = rendered[Symbol.asyncIterator]()
            const directCancel = Reflect.get(rendered, Symbol.for("vitehub.agent.stream.cancel"))
            const cancel = () => {
              if (hasRuntimeType(directCancel, "function")) directCancel(abortSignal.reason)
              void Promise.resolve(iterator.return?.(abortSignal.reason)).catch(() => {})
            }
            abortSignal.addEventListener("abort", cancel, { once: true })
            try {
              await writeEventsToUiMessageStream(writer, { [Symbol.asyncIterator]: () => iterator }, {
                onUsageRecord: usageRecord => { streamedUsageRecord = usageRecord },
                projection,
              })
            }
            finally {
              abortSignal.removeEventListener("abort", cancel)
            }
          },
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
  }), {
    omitUsageEvents: true,
    onChunk: onNormalizedChunk,
    onUsageRecord: usageRecord => { streamedUsageRecord = usageRecord },
  }), projection)
  let streamedText = ""
  return {
    deferFinish: shouldWrapOutput,
    finishResult: rendered,
    value: shouldWrapOutput
      ? withReadableStreamCleanup(stream, outcome => Promise.resolve(finish(outcome, streamedText, streamedUsageRecord)), {
          abortSignal,
          cancelOnAbort,
          onChunk(chunk) {
            streamedText += uiMessageTextDelta(chunk) || ""
            streamedUsageRecord = usageRecordFromStreamChunk(chunk, rendered) ?? streamedUsageRecord
          },
        })
      : stream,
  }
}
