import { toAgentPublicError } from "./agent-error.ts"
import type { StreamEvent } from "./messages.ts"
import type { AgentPublicErrorCode, AgentPublicErrorDetails } from "./agent-error.ts"
import type { AgentChannelDeliveryEffectIntent, AgentInspectionMetadata, AgentRunMetadata } from "./types.ts"

export const agentInvocationStreamRoute = "/__vitehub/agent/invocation-stream"
export const agentInvocationStreamHeader = "x-vitehub-agent-dev-loop"
export const agentInvocationStreamHeaderValue = "1"

export interface AgentDevLoopAgentSummary {
  aliases?: string[]
  name: string
  triggers: string[]
}

export interface AgentDevLoopDiscoveryResponse {
  agents: AgentDevLoopAgentSummary[]
  inspection?: AgentInspectionMetadata
  root: string
  workspaceDevTokenServerId?: string
}

export interface AgentInvocationStreamErrorEvent {
  code?: AgentPublicErrorCode | (string & {})
  details?: AgentPublicErrorDetails
  error: string
  requestId?: string
  type: "error"
}

export type AgentInvocationStreamEvent =
  | StreamEvent
  | { channelId?: string, effect: AgentChannelDeliveryEffectIntent, run?: AgentRunMetadata, type: "delivery-preview" }
  | AgentInvocationStreamErrorEvent
  | { data?: Record<string, unknown>, durationMs?: number, id: string, label?: string, phase: "workspace.prepare" | (string & {}), status: "completed" | "failed" | "started" | "updating", type: "progress" }
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

  function clearInactivityTimeout(): void {
    if (!timeout) return
    clearTimeout(timeout)
    timeout = undefined
  }

  function resetInactivityTimeout(controller: ReadableStreamDefaultController<Uint8Array>): void {
    clearInactivityTimeout()
    if (options.timeout && options.timeout > 0) {
      timeout = setTimeout(() => {
        const error = `Agent Invocation Stream timed out after ${options.timeout}ms of inactivity.`
        fail(controller, new Error(error), "invocation", { code: "INTERNAL", error })
      }, options.timeout)
    }
  }

  function close(controller: ReadableStreamDefaultController<Uint8Array>): void {
    clearInactivityTimeout()
    closed = true
    controller.close()
  }

  function write(controller: ReadableStreamDefaultController<Uint8Array>, event: AgentInvocationStreamEvent): void {
    controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
  }

  function closeFailed(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (closed) return
    try {
      write(controller, { type: "done" })
      close(controller)
    }
    catch (cause) {
      closed = true
      controller.error(cause)
    }
  }

  function fail(
    controller: ReadableStreamDefaultController<Uint8Array>,
    cause: unknown,
    context: "invocation" | "serialization" = "serialization",
    publicError?: Omit<AgentInvocationStreamErrorEvent, "type">,
  ): void {
    if (closed) return
    clearInactivityTimeout()
    abort(cause)
    try {
      write(controller, {
        ...(publicError ?? toAgentPublicError(cause, context)),
        type: "error",
      })
      closeFailed(controller)
    }
    catch {
      closed = true
      controller.error(cause)
    }
  }

  function abort(cause?: unknown): void {
    try {
      abortController.abort(cause)
    }
    catch (error) {
      if (!isAbortError(error)) throw error
    }
  }

  function emit(controller: ReadableStreamDefaultController<Uint8Array>, event: AgentInvocationStreamEvent): boolean {
    if (closed || abortController.signal.aborted) return false
    try {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      resetInactivityTimeout(controller)
      return true
    }
    catch (cause) {
      fail(controller, cause)
      return false
    }
  }

  return new Response(new ReadableStream({
    start(controller) {
      resetInactivityTimeout(controller)
      run(event => emit(controller, event), abortController.signal)
        .then(() => {
          if (closed || abortController.signal.aborted) return
          if (emit(controller, { type: "done" })) close(controller)
        })
        .catch((cause) => {
          if (closed || abortController.signal.aborted) return
          clearInactivityTimeout()
          emit(controller, {
            ...toAgentPublicError(cause, "invocation"),
            type: "error",
          })
          if (emit(controller, { type: "done" })) close(controller)
        })
    },
    cancel() {
      clearInactivityTimeout()
      closed = true
      abort()
    },
  }), {
    headers: { "content-type": "application/x-ndjson" },
  })
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError"
}
