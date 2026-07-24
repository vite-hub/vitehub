interface AgentStreamResult {
  toTextStreamResponse?: () => Response
  toUIMessageStreamResponse?: () => Response
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

const workflowProviders = new Set(["cloudflare", "openworkflow", "vercel"])
const workflowRunStatuses = new Set(["completed", "failed", "queued", "running", "unknown"])

export function isWorkflowRun(value: unknown): value is { id: string, metadata?: unknown, provider: string, result?: unknown, status: string } {
  if (typeof value !== "object" || value === null) return false
  const run = value as { id?: unknown, provider?: unknown, status?: unknown }
  const provider = run.provider
  const status = run.status
  return typeof run.id === "string"
    && typeof provider === "string"
    && workflowProviders.has(provider)
    && typeof status === "string"
    && workflowRunStatuses.has(status)
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

interface AgentUiMessageStreamResponseInit extends ResponseInit {
  consumeSseStream?: (input: { stream: ReadableStream<string> }) => void
  stream: ReadableStream<unknown>
}

export function toAgentUiMessageStreamResponse({
  consumeSseStream,
  headers,
  stream,
  ...init
}: AgentUiMessageStreamResponseInit): Response {
  let sseStream = stream.pipeThrough(new TransformStream<unknown, string>({
    flush(controller) {
      controller.enqueue("data: [DONE]\n\n")
    },
    transform(chunk, controller) {
      controller.enqueue(`data: ${JSON.stringify(chunk)}\n\n`)
    },
  }))
  if (consumeSseStream) {
    const [responseStream, consumedStream] = sseStream.tee()
    sseStream = responseStream
    consumeSseStream({ stream: consumedStream })
  }
  const responseHeaders = new Headers({
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
    "x-accel-buffering": "no",
    "x-vercel-ai-ui-message-stream": "v1",
  })
  new Headers(headers).forEach((value, key) => responseHeaders.set(key, value))
  return new Response(sseStream.pipeThrough(new TextEncoderStream()), {
    ...init,
    headers: responseHeaders,
  })
}

export function toJsonSafeAgentResult(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return value
  }

  if (isWorkflowRun(value)) {
    return {
      id: value.id,
      ...(value.metadata !== undefined ? { metadata: value.metadata } : {}),
      provider: value.provider,
      ...(value.result !== undefined ? { result: value.result } : {}),
      status: value.status,
    }
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
