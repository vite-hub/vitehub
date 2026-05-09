import { waitUntil as vercelWaitUntil } from "@vercel/functions"

import { runAgent, streamAgent } from "./index.ts"
import { createAgentRuntimeContext } from "./runtime/context.ts"

import type { AgentInput, AgentRequestBody, AgentRuntimeContext, AgentWaitUntil } from "./types.ts"

async function readJsonBody(request: Request): Promise<AgentRequestBody> {
  const body = await request.json().catch(() => undefined)
  return typeof body === "object" && body !== null ? body as AgentRequestBody : {}
}

function isStreamResult(value: unknown): value is { toUIMessageStreamResponse?: () => Response, toTextStreamResponse?: () => Response } {
  return typeof value === "object"
    && value !== null
    && (typeof (value as { toUIMessageStreamResponse?: unknown }).toUIMessageStreamResponse === "function"
      || typeof (value as { toTextStreamResponse?: unknown }).toTextStreamResponse === "function")
}

function toJsonSafeResult(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return value
  }

  const result = value as Record<string, unknown>
  return {
    finishReason: result.finishReason,
    text: result.text,
    usage: result.usage,
    warnings: result.warnings,
  }
}

function toResponse(value: unknown, stream: boolean): Response {
  if (value instanceof Response) {
    return value
  }
  if (stream && isStreamResult(value)) {
    if (value.toUIMessageStreamResponse) {
      return value.toUIMessageStreamResponse()
    }
    const response = value.toTextStreamResponse?.()
    if (response) return response
  }
  return Response.json(toJsonSafeResult(value))
}

export function defineVercelAgentHandler(
  agent: AgentInput<AgentRuntimeContext>,
  options: { waitUntil?: AgentWaitUntil } = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const waitUntil = options.waitUntil || vercelWaitUntil
    const context = createAgentRuntimeContext({
      request,
      runtime: "vercel" as const,
      vercel: { waitUntil },
      waitUntil,
    })
    const body = await readJsonBody(request)
    const stream = body.stream !== false
    const result = stream
      ? await streamAgent(agent, context, body)
      : await runAgent(agent, context, body)

    return toResponse(result, stream)
  }
}
