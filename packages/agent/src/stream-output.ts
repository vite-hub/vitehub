import { isAsyncIterable } from "./internal/stream-result.ts"

import type { MaybePromise } from "./types.ts"

interface FinalizedStreamOutput<T> {
  deferFinish: boolean
  finishResult: unknown
  value: ReadableStream<T>
}

interface AgentUIMessageStreamWriter {
  write(event: unknown): void
}

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
  cleanup: (error?: unknown) => Promise<void>,
  options: { onChunk?: (chunk: T) => void } = {},
): ReadableStream<T> {
  const reader = stream.getReader()
  let cleaned = false
  const runCleanup = async (error?: unknown) => {
    if (cleaned) return
    cleaned = true
    await cleanup(error)
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
        await runCleanup(error)
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
      await runCleanup(reason)
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

function uiMessageTextDelta(event: unknown): string | undefined {
  const type = streamEventType(event)
  if (type !== "text" && type !== "text-delta") return
  const text = (event as { delta?: unknown, text?: unknown, textDelta?: unknown }).text
    ?? (event as { delta?: unknown, textDelta?: unknown }).textDelta
    ?? (event as { delta?: unknown }).delta
  return typeof text === "string" ? text : undefined
}

function uiDataType(data: unknown): `data-${string}` {
  const rawType = typeof data === "object" && data !== null && typeof (data as { type?: unknown }).type === "string"
    ? (data as { type: string }).type
    : "event"
  const type = rawType.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return `data-${type || "event"}`
}

async function writeEventsToUiMessageStream(writer: AgentUIMessageStreamWriter, events: AsyncIterable<unknown>) {
  const messageId = crypto.randomUUID()
  let textStarted = false
  let finished = false
  writer.write({ type: "start", messageId })
  for await (const event of events) {
    const type = streamEventType(event)
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
    if (type === "data") {
      const data = (event as { data?: unknown }).data
      writer.write({ type: uiDataType(data), data })
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
  finish: (error?: unknown, streamedText?: string) => MaybePromise<void>,
): Promise<FinalizedStreamOutput<unknown>> {
  const hasUiMessageStream = isUIMessageStreamResult(rendered)
  const hasAsyncIterable = isAsyncIterable(rendered)
  const text = hasUiMessageStream || hasAsyncIterable ? undefined : textFromRenderedOutput(rendered)
  if (!hasUiMessageStream && !hasAsyncIterable && text === undefined) {
    throw new Error("[vitehub] Agent stream output \"ui-message-stream\" requires a result with toUIMessageStream().")
  }
  const stream = hasUiMessageStream
    ? rendered.toUIMessageStream()
    : hasAsyncIterable
      ? createAgentUIMessageStream({
          execute: async ({ writer }) => await writeEventsToUiMessageStream(writer, rendered),
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
      })
  let streamedText = ""
  return {
    deferFinish: shouldWrapOutput,
    finishResult: rendered,
    value: shouldWrapOutput
      ? withReadableStreamCleanup(stream, error => Promise.resolve(finish(error, streamedText)), {
          onChunk(chunk) {
            streamedText += uiMessageTextDelta(chunk) || ""
          },
        })
      : stream,
  }
}
