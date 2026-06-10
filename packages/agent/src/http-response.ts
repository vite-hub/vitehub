import type { AgentRequestBody } from "./types.ts"

interface AgentStreamResult {
  toTextStreamResponse?: () => Response
  toUIMessageStreamResponse?: () => Response
}

export async function readAgentRequestBody(request: Request): Promise<AgentRequestBody> {
  const body = await request.json().catch(() => undefined)
  return typeof body === "object" && body !== null ? body as AgentRequestBody : {}
}

function isAgentStreamResult(value: unknown): value is AgentStreamResult {
  return typeof value === "object"
    && value !== null
    && (typeof (value as { toUIMessageStreamResponse?: unknown }).toUIMessageStreamResponse === "function"
      || typeof (value as { toTextStreamResponse?: unknown }).toTextStreamResponse === "function")
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value
}

export function toAgentEventStreamResponse(stream: AsyncIterable<unknown>): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        }
        controller.close()
      }
      catch (error) {
        controller.error(error)
      }
    },
  }), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  })
}

export function toJsonSafeAgentResult(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return value
  }

  const result = value as Record<string, unknown>
  return {
    finishReason: result.finishReason,
    raw: result.raw,
    text: result.text,
    usage: result.usage,
    usageRecord: result.usageRecord,
    warnings: result.warnings,
  }
}

export function toAgentHttpResult(value: unknown, stream: boolean): Response | unknown {
  if (value instanceof Response) {
    return value
  }
  if (stream && isAgentStreamResult(value)) {
    if (value.toUIMessageStreamResponse) {
      return value.toUIMessageStreamResponse()
    }
    const response = value.toTextStreamResponse?.()
    if (response) return response
  }
  if (stream && isAsyncIterable(value)) {
    return toAgentEventStreamResponse(value)
  }
  return toJsonSafeAgentResult(value)
}

export function toAgentFetchResponse(value: unknown, stream: boolean): Response {
  const result = toAgentHttpResult(value, stream)
  return result instanceof Response ? result : Response.json(result)
}
