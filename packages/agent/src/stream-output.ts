import { isAsyncIterable } from "./internal/stream-result.ts"

import type { MaybePromise } from "./types.ts"

interface FinalizedStreamOutput<T> {
  deferFinish: boolean
  finishResult: unknown
  value: ReadableStream<T>
}

export function isUIMessageStreamResult(value: unknown): value is { toUIMessageStream: () => ReadableStream<unknown> } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { toUIMessageStream?: unknown }).toUIMessageStream === "function"
}

export function withReadableStreamCleanup<T>(stream: ReadableStream<T>, cleanup: (error?: unknown) => Promise<void>): ReadableStream<T> {
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

function uiDataType(data: unknown): `data-${string}` {
  const rawType = typeof data === "object" && data !== null && typeof (data as { type?: unknown }).type === "string"
    ? (data as { type: string }).type
    : "event"
  const type = rawType.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return `data-${type || "event"}`
}

async function writeEventsToUiMessageStream(writer: { write: (event: never) => void }, events: AsyncIterable<unknown>) {
  const messageId = crypto.randomUUID()
  let textStarted = false
  let finished = false
  writer.write({ type: "start", messageId } as never)
  for await (const event of events) {
    const type = streamEventType(event)
    if (type === "text-delta") {
      const text = (event as { delta?: unknown, text?: unknown }).text ?? (event as { delta?: unknown }).delta
      if (typeof text !== "string" || !text) continue
      if (!textStarted) {
        writer.write({ type: "text-start", id: messageId } as never)
        textStarted = true
      }
      writer.write({ type: "text-delta", id: messageId, delta: text } as never)
      continue
    }
    if (type === "tool-call") {
      const tool = event as { id?: unknown, input?: unknown, name?: unknown }
      writer.write({ type: "tool-input-available", toolCallId: tool.id, toolName: tool.name, input: tool.input } as never)
      continue
    }
    if (type === "tool-result") {
      const tool = event as { id?: unknown, output?: unknown }
      writer.write({ type: "tool-output-available", toolCallId: tool.id, output: tool.output } as never)
      continue
    }
    if (type === "data") {
      const data = (event as { data?: unknown }).data
      writer.write({ type: uiDataType(data), data } as never)
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
  if (textStarted) writer.write({ type: "text-end", id: messageId } as never)
  writer.write({ type: "finish", finishReason: finished ? "stop" : "unknown" } as never)
}

export async function finalizeUiMessageStreamOutput(
  rendered: unknown,
  shouldWrapOutput: boolean,
  finish: (error?: unknown) => MaybePromise<void>,
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
      ? (await import("ai")).createUIMessageStream({
          execute: async ({ writer }) => await writeEventsToUiMessageStream(writer, rendered),
        })
      : (await import("ai")).createUIMessageStream({
        execute({ writer }) {
          const messageId = crypto.randomUUID()
          writer.write({ type: "start", messageId })
          writer.write({ type: "text-start", id: messageId })
          writer.write({ type: "text-delta", id: messageId, delta: text || "" })
          writer.write({ type: "text-end", id: messageId })
          writer.write({ type: "finish", finishReason: "stop" })
        },
      })
  return {
    deferFinish: shouldWrapOutput,
    finishResult: rendered,
    value: shouldWrapOutput
      ? withReadableStreamCleanup(stream, error => Promise.resolve(finish(error)))
      : stream,
  }
}
