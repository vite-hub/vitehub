import { isAsyncIterable } from "./internal/stream-result.ts"
import { hasRuntimeType, isRuntimeRecord } from "./internal/runtime-type.ts"
import { usageRecordFromStreamChunk } from "./agent-output.ts"

import type { AgentUIMessageStreamProjection, AgentUsageRecord, MaybePromise } from "./types.ts"
import { agentDiagnostics } from "./agent-diagnostics.ts"

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
  return isRuntimeRecord(value) && hasRuntimeType(value.toUIMessageStream, "function")
}

// `type` is an additional intrinsic-slot accessor. Requiring it keeps the
// compatibility boundary from accepting a class that merely copies the
// stream-facing getters while retaining support for genuine foreign realms.
const responseSnapshotProperties = ["status", "statusText", "headers", "body", "type"] as const
const responsePrototypeLimit = 32
const intrinsicResponse = Response
const intrinsicHeaders = Headers
const intrinsicReadableStream = ReadableStream
type ResponsePrototype = Record<PropertyKey, unknown>

function responsePropertyDescriptor(value: unknown, key: PropertyKey): PropertyDescriptor | undefined {
  let current: object | null = Object(value)
  const seen = new Set<object>()
  for (let depth = 0; current && depth < responsePrototypeLimit; depth++) {
    if (seen.has(current)) throw new Error("Cyclic Response prototype")
    seen.add(current)
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) return descriptor
    current = Object.getPrototypeOf(current)
  }
  if (current) throw new Error("Response prototype chain is too deep")
}

function responsePrototype(value: unknown): ResponsePrototype | undefined {
  let prototype: object | null = Object.getPrototypeOf(Object(value))
  const seen = new Set<object>()
  for (let depth = 0; prototype && depth < responsePrototypeLimit; depth++) {
    if (seen.has(prototype)) return
    seen.add(prototype)
    const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
    const hasAccessors = responseSnapshotProperties.every(key => Object.getOwnPropertyDescriptor(prototype, key)?.get)
    const clone = Object.getOwnPropertyDescriptor(prototype, "clone")?.value
    if (constructor?.name === "Response" && hasAccessors && hasRuntimeType(clone, "function")) {
      // SAFETY: every accepted property is inspected on this prototype before narrowing it.
      return prototype as ResponsePrototype
    }
    prototype = Object.getPrototypeOf(prototype)
  }
}

function hasResponsePrototype(value: unknown): boolean {
  const branded = responsePrototype(value)
  if (!branded) return false
  // Own accessors are allowed: a genuine Response can expose a changing
  // snapshot through own properties. Reject replacement accessors on any
  // prototype between the candidate and its branded Response prototype.
  let current: object | null = Object.getPrototypeOf(Object(value))
  const seen = new Set<object>()
  while (current && current !== branded) {
    if (seen.has(current)) return false
    seen.add(current)
    for (const key of responseSnapshotProperties) {
      if (Object.prototype.hasOwnProperty.call(current, key)) return false
    }
    current = Object.getPrototypeOf(current)
  }
  return current === branded
}

function hasResponseBrand(value: unknown, branded: ResponsePrototype): boolean {
  // The selected realm's intrinsic getter performs the internal-slot check.
  // This rejects carriers inheriting from a genuine Response prototype while
  // preserving genuine Responses from other realms.
  const statusGetter = Object.getOwnPropertyDescriptor(branded, "status")?.get
  if (!statusGetter) return false
  Reflect.apply(statusGetter, value, [])
  return true
}

export function isUIMessageStreamResponse(value: unknown): value is Response & { body: ReadableStream<Uint8Array> } {
  try {
    // Response accessors perform an internal-slot brand check, so the host
    // realm's getters reject an otherwise genuine Response from another realm.
    // Select the accessors from the candidate's branded Response prototype.
    if (!hasResponsePrototype(value)) return false
    const branded = responsePrototype(value)
    if (!branded || !hasResponseBrand(value, branded)) return false
    const bodyGetter = responsePropertyDescriptor(value, "body")?.get
    const headersGetter = responsePropertyDescriptor(value, "headers")?.get
    const body = bodyGetter && Reflect.apply(bodyGetter, value, [])
    const headers = headersGetter && Reflect.apply(headersGetter, value, [])
    const lockedGetter = body && readableStreamDescriptor(body, "locked")?.get
    const get = headers && headersDescriptor(headers, "get")?.value
    if (!body || !headers || !lockedGetter || !hasRuntimeType(get, "function")) return false
    Reflect.apply(lockedGetter, body, [])
    return Reflect.apply(get, headers, ["x-vercel-ai-ui-message-stream"]) === "v1"
  }
  catch {
    return false
  }
}

function isPortableUIMessageBody(body: unknown): body is ReadableStream<Uint8Array> {
  if (!isRuntimeRecord(body)) return false
  const lockedGetter = readableStreamDescriptor(body, "locked")?.get
  const getReader = readableStreamDescriptor(body, "getReader")?.value
  if (!lockedGetter || !hasRuntimeType(getReader, "function")) return false
  if (Reflect.apply(lockedGetter, body, [])) return false
  const ownReader = Object.getOwnPropertyDescriptor(body, "getReader")
  return !ownReader || ownReader.value === getReader
}

function readableStreamDescriptor(value: unknown, key: PropertyKey): PropertyDescriptor | undefined {
  let current: object | null = Object(value)
  const seen = new Set<object>()
  for (let depth = 0; current && depth < responsePrototypeLimit; depth++) {
    if (seen.has(current)) return
    seen.add(current)
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) {
      const constructor = Object.getOwnPropertyDescriptor(current, "constructor")?.value
      if (constructor?.name !== "ReadableStream") return
      return descriptor
    }
    current = Object.getPrototypeOf(current)
  }
}

function headersDescriptor(value: unknown, key: PropertyKey): PropertyDescriptor | undefined {
  let current: object | null = Object(value)
  const seen = new Set<object>()
  for (let depth = 0; current && depth < responsePrototypeLimit; depth++) {
    if (seen.has(current)) return
    seen.add(current)
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) {
      const constructor = Object.getOwnPropertyDescriptor(current, "constructor")?.value
      if (constructor?.name !== "Headers") return
      return descriptor
    }
    current = Object.getPrototypeOf(current)
  }
}

function bridgeUIMessageBody(body: ReadableStream<Uint8Array>) {
  // Use the source realm's native operations, never caller-supplied methods.
  // SAFETY: readableStreamDescriptor only returns the branded ReadableStream prototype's getReader method.
  const getReader = readableStreamDescriptor(body, "getReader")?.value as () => ReadableStreamDefaultReader<Uint8Array>
  const reader = Reflect.apply(getReader, body, [])
  const readerPrototype = Object.getPrototypeOf(reader)
  // SAFETY: readerPrototype is the native prototype of the reader returned by the branded stream.
  const read = Object.getOwnPropertyDescriptor(readerPrototype, "read")?.value as ReadableStreamDefaultReader<Uint8Array>["read"]
  // SAFETY: readerPrototype is the native prototype of the reader returned by the branded stream.
  const cancel = Object.getOwnPropertyDescriptor(readerPrototype, "cancel")?.value as ReadableStreamDefaultReader<Uint8Array>["cancel"]
  // SAFETY: readerPrototype is the native prototype of the reader returned by the branded stream.
  const releaseLock = Object.getOwnPropertyDescriptor(readerPrototype, "releaseLock")?.value as ReadableStreamDefaultReader<Uint8Array>["releaseLock"]
  let released = false
  const release = () => {
    if (released) return
    released = true
    Reflect.apply(releaseLock, reader, [])
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await Reflect.apply(read, reader, [])
        if (result.done) {
          release()
          controller.close()
        }
        else controller.enqueue(result.value)
      }
      catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await Reflect.apply(cancel, reader, [reason])
      }
      finally {
        release()
      }
    },
  }, { highWaterMark: 0 })
  return { stream, release }
}

export function normalizeUIMessageStreamResponse(value: unknown): (Response & { body: ReadableStream<Uint8Array> }) | undefined {
  if (!isRuntimeRecord(value)) return
  try {
    // This shape only selects compatibility candidates. It does not prove origin.
    if (!hasResponsePrototype(value)) return
    const branded = responsePrototype(value)
    if (!branded || !hasResponseBrand(value, branded)) return
    const status: unknown = Reflect.get(value, "status")
    const statusText: unknown = Reflect.get(value, "statusText")
    const headers: unknown = Reflect.get(value, "headers")
    const body: unknown = Reflect.get(value, "body")
    if (!hasRuntimeType(status, "number") || !Number.isInteger(status) || status < 200 || status > 599) return
    if (!hasRuntimeType(statusText, "string") || !isRuntimeRecord(headers) || !isRuntimeRecord(body)) return
    const type: unknown = Reflect.get(value, "type")
    if (!hasRuntimeType(type, "string")) return
    const snapshot = { status, statusText, headers, body, type }
    const markerGetter = headersDescriptor(headers, "get")?.value
    if (!branded || !hasRuntimeType(markerGetter, "function")
      || Reflect.apply(markerGetter, headers, ["x-vercel-ai-ui-message-stream"]) !== "v1") return
    const nativeProperties = value instanceof intrinsicResponse && snapshot.type === type && hasResponsePrototype(value)
    const nativeHeaders = ["get", "forEach"].every(key =>
      responsePropertyDescriptor(headers, key)?.value === Object.getOwnPropertyDescriptor(intrinsicHeaders.prototype, key)?.value)
    const cookieDescriptor = responsePropertyDescriptor(headers, "getSetCookie")
    const nativeCookies = !cookieDescriptor?.get && (cookieDescriptor?.value === undefined
      || cookieDescriptor.value === Object.getOwnPropertyDescriptor(intrinsicHeaders.prototype, "getSetCookie")?.value)
    const nativeReader = responsePropertyDescriptor(body, "getReader")?.value === intrinsicReadableStream.prototype.getReader
    if (nativeProperties && nativeHeaders && nativeCookies && nativeReader) return value as Response & { body: ReadableStream<Uint8Array> }
    if (!isPortableUIMessageBody(body)) return
    const forEach = Reflect.get(headers, "forEach")
    if (!hasRuntimeType(forEach, "function")) return
    const getSetCookie = Reflect.get(headers, "getSetCookie")
    const cookies: unknown = hasRuntimeType(getSetCookie, "function") ? Reflect.apply(getSetCookie, headers, []) : []
    if (!Array.isArray(cookies)) return
    const normalizedHeaders = new Headers()
    Reflect.apply(forEach, headers, [(headerValue: string, key: string) => {
      if (key.toLowerCase() !== "set-cookie" || cookies.length === 0) normalizedHeaders.append(key, headerValue)
    }])
    for (const cookie of cookies) normalizedHeaders.append("set-cookie", cookie)
    if (normalizedHeaders.get("x-vercel-ai-ui-message-stream") !== "v1") return
    // Consumption uses a stable local snapshot and the branded stream, never
    // methods supplied by a Response-shaped carrier.
    const bridgedBody = bridgeUIMessageBody(body)
    try {
      const response = new Response(bridgedBody.stream, { status, statusText, headers: normalizedHeaders })
      return isUIMessageStreamResponse(response) ? response : undefined
    }
    catch (error) {
      bridgedBody.release()
      throw error
    }
  }
  catch {
    return
  }
}

export function uiMessageStreamFromResponse(response: Response & { body: ReadableStream<Uint8Array> }): ReadableStream<unknown> {
  const normalized = normalizeUIMessageStreamResponse(response)
  if (!normalized) throw new TypeError("Expected a readable UI message stream Response")
  const body = normalized.body
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
  // SAFETY: The local native stream is piped through a TransformStream whose output type is unknown.
  return Reflect.apply(ReadableStream.prototype.pipeThrough, body, [new TransformStream<Uint8Array, unknown>({
    flush(controller) {
      buffer += decoder.decode()
      if (buffer.trim()) buffer += "\n\n"
      enqueueFrames(controller, true)
    },
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      enqueueFrames(controller)
    },
  })]) as ReadableStream<unknown>
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
}): Response & { body: ReadableStream<Uint8Array> } {
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
  // SAFETY: Constructing a Response with a ReadableStream always creates a non-null body.
  return new Response(stream, {
    headers,
    status: options.status,
    statusText: options.statusText,
  }) as Response & { body: ReadableStream<Uint8Array> }
}

export function cancellableAsyncIterableSource(stream: AsyncIterable<unknown>): {
  cancel: (reason?: unknown) => Promise<void>
  readonly completed: boolean
  stream: AsyncIterable<unknown>
} {
  const readableReader = isReadableAsyncIterable(stream)
    ? stream.getReader()
    : undefined
  const iterator: AsyncIterator<unknown> = readableReader
    ? {
        next: () => readableReader.read(),
        async return(reason) {
          try {
            await readableReader.cancel(reason)
          }
          finally {
            readableReader.releaseLock()
          }
          return { done: true, value: undefined }
        },
      }
    : stream[Symbol.asyncIterator]()
  let cancelTask: Promise<void> | undefined
  let completed = false
  const cancel = async (reason?: unknown) => {
    if (completed) return
    cancelTask ||= Promise.resolve(iterator.return?.(reason)).then(() => {})
    await cancelTask
  }
  return {
    cancel,
    get completed() {
      return completed
    },
    stream: (async function* () {
      try {
        for (;;) {
          const chunk = await iterator.next()
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
    })(),
  }
}

function isReadableAsyncIterable(stream: AsyncIterable<unknown>): stream is AsyncIterable<unknown> & ReadableStream<unknown> {
  return isRuntimeRecord(stream) && hasRuntimeType(stream.getReader, "function")
}

export function withReadableStreamCleanup<T>(
  stream: ReadableStream<T>,
  cleanup: (outcome: StreamCleanupOutcome) => Promise<void>,
  options: { abortSignal?: AbortSignal, cancelOnAbort?: (reason: unknown) => Promise<void>, detachPendingReaderCancellation?: boolean, onChunk?: (chunk: T) => void } = {},
): ReadableStream<T> {
  const reader = stream.getReader()
  let cleaned = false
  let cleanupTask: Promise<void> | undefined
  let pendingCleanupOutcome: StreamCleanupOutcome | undefined
  let pendingError: unknown
  let wrappedController: ReadableStreamDefaultController<T> | undefined
  const runCleanup = async (outcome: StreamCleanupOutcome = pendingCleanupOutcome ?? { completed: true, failed: false }) => {
    if (cleanupTask) return await cleanupTask
    cleaned = true
    options.abortSignal?.removeEventListener("abort", onAbort)
    cleanupTask = Promise.resolve(cleanup(outcome))
    await cleanupTask
  }
  const onAbort = () => {
    const reason = options.abortSignal?.reason ?? new DOMException("[vitehub] Agent Invocation stream aborted.", "AbortError")
    if (cleaned) return
    pendingCleanupOutcome = { error: reason, failed: true }
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
      pendingCleanupOutcome = outcome
      let detachedReaderSettlement: Promise<true> | undefined
      try {
        await options.cancelOnAbort?.(reason)
        const readerCancellation = reader.cancel(reason)
        if (options.detachPendingReaderCancellation) {
          detachedReaderSettlement = readerCancellation.then(() => true, () => true)
          void readerCancellation.catch(() => {})
        }
        else await readerCancellation
      }
      catch (error) {
        outcome = { error, failed: true }
        pendingCleanupOutcome = outcome
        throw error
      }
      finally {
        const cleanup = runCleanup(outcome)
        if (detachedReaderSettlement) {
          const settled = await Promise.race([
            detachedReaderSettlement,
            new Promise<false>(resolve => setTimeout(() => resolve(false), 0)),
          ])
          if (settled) await cleanup
          else void cleanup.catch(() => {})
        }
        else await cleanup
      }
    },
  })
  if (options.abortSignal?.aborted) onAbort()
  else options.abortSignal?.addEventListener("abort", onAbort, { once: true })
  return wrapped
}

function textFromRenderedOutput(rendered: unknown): string | undefined {
  if (hasRuntimeType(rendered, "string")) return rendered
  if (!isRuntimeRecord(rendered)) return undefined
  return hasRuntimeType(rendered.text, "string") ? rendered.text : undefined
}

function streamEventType(event: unknown): string | undefined {
  return isRuntimeRecord(event) && hasRuntimeType(event.type, "string") ? event.type : undefined
}

export function uiMessageTextDelta(event: unknown): string | undefined {
  const type = streamEventType(event)
  if ((type !== "text" && type !== "text-delta") || !isRuntimeRecord(event)) return
  const text = event.text ?? event.textDelta ?? event.delta
  return hasRuntimeType(text, "string") ? text : undefined
}

function uiMessageStreamError(event: unknown): Error | undefined {
  if (streamEventType(event) !== "error" || !isRuntimeRecord(event)) return
  if (event.recoverable === true) return
  if (event.error instanceof Error) return event.error
  const message = event.errorText ?? event.message ?? event.error
  return agentDiagnostics.AGENT_R0856({ message: hasRuntimeType(message, "string") && message ? message : "Agent stream failed." })
}

function isCapabilityCliInput(input: unknown): input is { argv: string[], input?: unknown, json?: boolean } {
  if (!isRuntimeRecord(input) || Array.isArray(input)) return false
  const argv = input.argv
  return Object.keys(input).every(key => key === "argv" || key === "input" || key === "json")
    && Array.isArray(argv)
    && argv.every(arg => hasRuntimeType(arg, "string"))
    && (input.json === undefined || hasRuntimeType(input.json, "boolean"))
}

export function normalizeUiMessageStreamChunk(chunk: unknown): unknown {
  if (!isRuntimeRecord(chunk)) return chunk
  const record = chunk
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
  const metadata = isRuntimeRecord(record.toolMetadata) ? record.toolMetadata : undefined
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
  const hiddenTextIds = new Set<string>()
  return stream.pipeThrough(new TransformStream<unknown, unknown>({
    flush(controller) {
      for (const start of pendingTextStarts.values()) controller.enqueue(start)
    },
    transform(chunk, controller) {
      const type = streamEventType(chunk)
      if (projection.reasoning === "hidden" || projection.commentary === "hidden") {
        if (projection.reasoning === "hidden" && type?.startsWith("reasoning-")) return
        const text = isRuntimeRecord(chunk) ? chunk : {}
        const id = hasRuntimeType(text.id, "string") ? text.id : undefined
        if (type === "text-start" && id) {
          hiddenTextIds.delete(id)
          pendingTextStarts.delete(id)
          if (isHiddenTextPhase(projection, text.phase)) {
            hiddenTextIds.add(id)
            return
          }
          pendingTextStarts.set(id, chunk)
          return
        }
        if (text.phase !== undefined && id) {
          if (isHiddenTextPhase(projection, text.phase)) {
            hiddenTextIds.add(id)
          }
          else {
            hiddenTextIds.delete(id)
          }
        }
        const hidden = isHiddenTextPhase(projection, text.phase) || Boolean(id && hiddenTextIds.has(id))
        if (type === "text-end" && id) hiddenTextIds.delete(id)
        if (hidden) {
          if (type === "text-end" && id) pendingTextStarts.delete(id)
          return
        }
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

function isHiddenTextPhase(projection: AgentUIMessageStreamProjection, phase: unknown): boolean {
  return (projection.reasoning === "hidden" && phase === "reasoning")
    || (projection.commentary === "hidden" && phase === "commentary")
}

function uiDataType(data: unknown): `data-${string}` {
  const rawType = isRuntimeRecord(data) && hasRuntimeType(data.type, "string")
    ? data.type
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
  const hiddenTextIds = new Set<string>()
  writer.write({ type: "start", messageId })
  for await (const event of events) {
    const usageRecord = usageRecordFromStreamChunk(event, events)
    if (usageRecord) options.onUsageRecord?.(usageRecord)
    const type = streamEventType(event)
    if (!type || !isRuntimeRecord(event)) continue
    if (type === "usage" && usageRecord) continue
    if (options.projection?.reasoning === "hidden" || options.projection?.commentary === "hidden") {
      const id = hasRuntimeType(event.id, "string") ? event.id : undefined
      if (type === "text-start" && id) {
        hiddenTextIds.delete(id)
      }
      if (event.phase !== undefined && id) {
        if (isHiddenTextPhase(options.projection, event.phase)) hiddenTextIds.add(id)
        else hiddenTextIds.delete(id)
      }
      const hidden = (options.projection.reasoning === "hidden" && type.startsWith("reasoning-"))
        || isHiddenTextPhase(options.projection, event.phase)
        || Boolean(id && hiddenTextIds.has(id))
      if (type === "text-end" && id) hiddenTextIds.delete(id)
      if (hidden) continue
    }
    if (type === "text-delta") {
      const text = event.text ?? event.delta
      if (!hasRuntimeType(text, "string") || !text) continue
      if (!textStarted) {
        writer.write({ type: "text-start", id: messageId })
        textStarted = true
      }
      writer.write({ type: "text-delta", id: messageId, delta: text })
      continue
    }
    if (type === "tool-call") {
      writer.write({ type: "tool-input-available", toolCallId: event.id, toolName: event.name, input: event.input })
      continue
    }
    if (type === "tool-result") {
      if (hasRuntimeType(event.error, "string")) {
        writer.write({ type: "tool-output-error", toolCallId: event.id, toolName: event.name, errorText: event.error })
        continue
      }
      writer.write({ type: "tool-output-available", toolCallId: event.id, toolName: event.name, output: event.output })
      continue
    }
    if (type === "data" || type.startsWith("data-")) {
      writer.write({ type: type === "data" ? uiDataType(event.data) : type, data: event.data, id: event.id, ...(hasRuntimeType(event.transient, "boolean") ? { transient: event.transient } : {}) })
      continue
    }
    if (type === "finish") {
      finished = true
      break
    }
    if (type === "error") {
      if (event.recoverable === true) {
        writer.write(normalizeUiMessageStreamChunk(event))
        continue
      }
      throw event.error instanceof Error
        ? event.error
        : agentDiagnostics.AGENT_R0857({ message: hasRuntimeType(event.error, "string") ? event.error : hasRuntimeType(event.message, "string") ? event.message : "Agent stream failed." })
    }
  }
  if (textStarted) writer.write({ type: "text-end", id: messageId })
  writer.write({ type: "finish", finishReason: finished ? "stop" : "unknown" })
}

export async function finalizeUiMessageStreamOutput(
  rendered: unknown,
  shouldWrapOutput: boolean,
  finish: (outcome: StreamCleanupOutcome, streamedText?: string, streamedUsageRecord?: AgentUsageRecord) => MaybePromise<void>,
  options: {
    abortSignal?: AbortSignal
    cancelOnAbort?: (reason: unknown) => Promise<void>
    detachPendingReaderCancellation?: boolean
    onNormalizedChunk?: (chunk: unknown) => void
    projection?: AgentUIMessageStreamProjection
  } = {},
): Promise<FinalizedStreamOutput<unknown>> {
  const { abortSignal, cancelOnAbort, detachPendingReaderCancellation, onNormalizedChunk, projection } = options
  const hasUiMessageStream = isUIMessageStreamResult(rendered)
  const hasAsyncIterable = isAsyncIterable(rendered)
  const text = hasUiMessageStream || hasAsyncIterable ? undefined : textFromRenderedOutput(rendered)
  if (!hasUiMessageStream && !hasAsyncIterable && text === undefined) {
    throw agentDiagnostics.AGENT_R0858({ message: "[vitehub] Agent stream output \"ui-message-stream\" requires a result with toUIMessageStream()." })
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
          detachPendingReaderCancellation,
          onChunk(chunk) {
            streamedText += uiMessageTextDelta(chunk) || ""
            streamedUsageRecord = usageRecordFromStreamChunk(chunk, rendered) ?? streamedUsageRecord
          },
        })
      : stream,
  }
}
