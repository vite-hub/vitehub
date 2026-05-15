import type { AgentInput, AgentRequestBody, AgentRuntimeContext, CloudflareExportedHandlerFetchHandler } from "./types.ts"

import { runAgent, streamAgent } from "./index.ts"
import { createAgentRuntimeContext } from "./runtime/context.ts"

type RouteAgentRequest = (request: Request, env: Record<string, unknown>, options?: Record<string, unknown>) => Promise<Response | undefined> | Response | undefined

async function loadRouteAgentRequest(): Promise<RouteAgentRequest> {
  const mod = await import("agents")
  return mod.routeAgentRequest as RouteAgentRequest
}

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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value
}

function toEventStreamResponse(stream: AsyncIterable<unknown>): Response {
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

function toJsonSafeResult(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return value
  }

  const result = value as Record<string, unknown>
  return {
    finishReason: result.finishReason,
    raw: result.raw,
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
  if (stream && isAsyncIterable(value)) {
    return toEventStreamResponse(value)
  }
  return Response.json(toJsonSafeResult(value))
}

export function defineCloudflareAgentHandler(
  agent: AgentInput<AgentRuntimeContext>,
): CloudflareExportedHandlerFetchHandler<Record<string, unknown>> {
  return async (request, env, executionContext) => {
    const context = createAgentRuntimeContext({
      cloudflare: {
        context: executionContext,
        env,
      },
      request,
      runtime: "cloudflare-agents" as const,
      waitUntil: task => executionContext.waitUntil?.(task),
    })
    const body = await readJsonBody(request.clone())
    const stream = body.stream !== false
    const result = stream
      ? await streamAgent(agent, context, body)
      : await runAgent(agent, context, body)

    return toResponse(result, stream)
  }
}

export function defineCloudflareAgentsRouter(
  options: Record<string, unknown> = {},
): CloudflareExportedHandlerFetchHandler<Record<string, unknown>> {
  return async (request, env) => {
    const routeAgentRequest = await loadRouteAgentRequest()
    const response = await routeAgentRequest(request, env, options)
    return response || new Response("Not found", { status: 404 })
  }
}
