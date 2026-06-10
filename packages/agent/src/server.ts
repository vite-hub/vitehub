import { streamAgentTrigger } from "./index.ts"
import { createAgentRuntimeContext } from "./runtime/context.ts"
import { toHttpErrorResponse } from "./http-error.ts"

import type { AgentChatMessageTriggerInput } from "./chat-trigger.ts"
import type {
  AgentInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentRuntimeContext,
} from "./types.ts"

interface ViteAgentRouteRuntimeConfig extends AgentRuntimeConfig {
  agent?: unknown
}

interface ViteAgentRouteRuntimeContext extends AgentRuntimeContext<ViteAgentRouteRuntimeConfig> {
  request: Request
  runtime: "vite"
  runtimeConfig: ViteAgentRouteRuntimeConfig
}

type AgentChatRouteBody = AgentChatMessageTriggerInput & {
  stream?: boolean
}

async function readJsonBody(request: Request): Promise<AgentChatRouteBody> {
  const body = await request.json().catch(() => undefined)
  return typeof body === "object" && body !== null ? body as AgentChatRouteBody : { messages: [] }
}

function readableStreamFromResult(value: unknown): ReadableStream<unknown> {
  if (value instanceof ReadableStream) return value
  if (value instanceof Response && value.body) return value.body
  throw new Error("[vitehub] Agent chat route expected a UI message stream.")
}

function createBadRequest(message: string): Response {
  return Response.json({
    error: true,
    status: 400,
    statusText: message,
    message,
  }, { status: 400 })
}

function createRuntimeContext(request: Request, run: AgentRunMetadata | undefined): ViteAgentRouteRuntimeContext {
  return createAgentRuntimeContext({
    request,
    ...(run ? { run } : {}),
    runtime: "vite",
    runtimeConfig: {},
    waitUntil: task => void Promise.resolve(task).catch(() => {}),
  }) as ViteAgentRouteRuntimeContext
}

async function toUiMessageStreamResponse(stream: ReadableStream<unknown>): Promise<Response> {
  const { createUIMessageStreamResponse } = await import("ai") as {
    createUIMessageStreamResponse: (options: { stream: ReadableStream<unknown> }) => Response
  }
  return createUIMessageStreamResponse({ stream })
}

export function defineAgentChatFetchHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const body = await readJsonBody(request.clone())
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return createBadRequest("Agent chat route requires messages.")
    }

    try {
      const result = await streamAgentTrigger(agent as never, createRuntimeContext(request, body.run), "chat.message", body, {
        output: "ui-message-stream",
      })
      return await toUiMessageStreamResponse(readableStreamFromResult(result))
    }
    catch (error) {
      const response = toHttpErrorResponse(error)
      if (response) return response
      throw error
    }
  }
}
