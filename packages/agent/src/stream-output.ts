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

export async function finalizeUiMessageStreamOutput(
  rendered: unknown,
  shouldWrapOutput: boolean,
  finish: (error?: unknown) => MaybePromise<void>,
): Promise<FinalizedStreamOutput<unknown>> {
  const text = textFromRenderedOutput(rendered)
  if (!isUIMessageStreamResult(rendered) && text === undefined) {
    throw new Error("[vitehub] Agent stream output \"ui-message-stream\" requires a result with toUIMessageStream().")
  }
  const stream = isUIMessageStreamResult(rendered)
    ? rendered.toUIMessageStream()
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
