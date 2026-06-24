import type { StreamEvent } from "./messages.ts"
import type { AgentChannelDeliveryEffectIntent, AgentRunMetadata } from "./types.ts"

export const agentInvocationStreamRoute = "/__vitehub/agent/invocation-stream"
export const agentInvocationStreamHeader = "x-vitehub-agent-dev-loop"
export const agentInvocationStreamHeaderValue = "1"

export type AgentInvocationStreamEvent =
  | StreamEvent
  | { channelId?: string, effect: AgentChannelDeliveryEffectIntent, run?: AgentRunMetadata, type: "delivery-preview" }
  | { error: string, type: "error" }
  | { agent: string, metadata?: Record<string, unknown>, run?: unknown, trigger?: string, type: "start" }
  | { type: "done" }

export async function* readAgentInvocationStream(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentInvocationStreamEvent> {
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
        if (line.trim()) yield JSON.parse(line) as AgentInvocationStreamEvent
      }
    }
    if (pending.trim()) yield JSON.parse(pending) as AgentInvocationStreamEvent
  }
  finally {
    reader.releaseLock()
  }
}

export function createAgentInvocationStreamResponse(
  run: (emit: (event: AgentInvocationStreamEvent) => void, signal: AbortSignal) => Promise<void>,
  options: { timeout?: number } = {},
): Response {
  const encoder = new TextEncoder()
  const abortController = new AbortController()
  let closed = false
  let timeout: ReturnType<typeof setTimeout> | undefined

  function clearTimeoutSignal(): void {
    if (!timeout) return
    clearTimeout(timeout)
    timeout = undefined
  }

  function close(controller: ReadableStreamDefaultController<Uint8Array>): void {
    clearTimeoutSignal()
    closed = true
    controller.close()
  }

  function fail(controller: ReadableStreamDefaultController<Uint8Array>, cause: unknown): void {
    if (closed) return
    clearTimeoutSignal()
    abortController.abort(cause)
    try {
      controller.enqueue(encoder.encode(`${JSON.stringify({
        error: cause instanceof Error ? cause.message : "Agent Invocation Stream event could not be serialized.",
        type: "error",
      })}\n${JSON.stringify({ type: "done" })}\n`))
      close(controller)
    }
    catch {
      closed = true
      controller.error(cause)
    }
  }

  function emit(controller: ReadableStreamDefaultController<Uint8Array>, event: AgentInvocationStreamEvent): boolean {
    if (closed || abortController.signal.aborted) return false
    try {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      return true
    }
    catch (cause) {
      fail(controller, cause)
      return false
    }
  }

  return new Response(new ReadableStream({
    start(controller) {
      if (options.timeout && options.timeout > 0) {
        timeout = setTimeout(() => {
          fail(controller, new Error(`Agent Invocation Stream timed out after ${options.timeout}ms.`))
        }, options.timeout)
      }
      run(event => emit(controller, event), abortController.signal)
        .then(() => {
          if (closed || abortController.signal.aborted) return
          if (emit(controller, { type: "done" })) close(controller)
        })
        .catch((cause) => {
          if (closed || abortController.signal.aborted) return
          clearTimeoutSignal()
          emit(controller, {
            error: cause instanceof Error ? cause.message : "Agent Invocation Stream failed.",
            type: "error",
          })
          if (emit(controller, { type: "done" })) close(controller)
        })
    },
    cancel() {
      clearTimeoutSignal()
      closed = true
      abortController.abort()
    },
  }), {
    headers: { "content-type": "application/x-ndjson" },
  })
}
