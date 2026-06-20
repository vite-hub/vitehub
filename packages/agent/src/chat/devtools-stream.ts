import type { ChatDevtoolsStreamEvent } from "./devtools-shared.js"

export async function* readChatDevtoolsStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatDevtoolsStreamEvent> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += value
      const lines = pending.split("\n")
      pending = lines.pop() || ""
      for (const line of lines) {
        if (line.trim()) yield JSON.parse(line) as ChatDevtoolsStreamEvent
      }
    }
    if (pending.trim()) yield JSON.parse(pending) as ChatDevtoolsStreamEvent
  }
  finally {
    reader.releaseLock()
  }
}

export function createChatDevtoolsStreamResponse(run: (emit: (event: ChatDevtoolsStreamEvent) => void, signal: AbortSignal) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const abortController = new AbortController()
  let closed = false

  function emit(controller: ReadableStreamDefaultController<Uint8Array>, event: ChatDevtoolsStreamEvent): void {
    if (closed || abortController.signal.aborted) return
    try {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
    }
    catch {
      closed = true
      abortController.abort()
    }
  }

  return new Response(new ReadableStream({
    start(controller) {
      run(event => emit(controller, event), abortController.signal)
        .then(() => {
          if (closed || abortController.signal.aborted) return
          emit(controller, { type: "done" })
          if (!closed) {
            closed = true
            controller.close()
          }
        })
        .catch((cause) => {
          if (closed || abortController.signal.aborted) return
          emit(controller, {
            message: cause instanceof Error ? cause.message : "Chat DevTools stream failed.",
            type: "error",
          })
          if (!closed) {
            closed = true
            controller.close()
          }
        })
    },
    cancel() {
      closed = true
      abortController.abort()
    },
  }), {
    headers: { "content-type": "application/x-ndjson" },
  })
}
