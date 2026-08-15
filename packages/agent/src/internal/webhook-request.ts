interface AgentWebhookNodeRequest {
  aborted?: boolean
  once: (event: "aborted", listener: () => void) => unknown
}

interface AgentWebhookNodeResponse {
  once: (event: "close", listener: () => void) => unknown
  writableEnded?: boolean
}

export interface AgentWebhookRequestInput {
  body?: RequestInit["body"]
  headers?: RequestInit["headers"]
  method: string
  node?: {
    req?: AgentWebhookNodeRequest
    res?: AgentWebhookNodeResponse
  }
  signal: AbortSignal
  url: string | URL
}

export function createAgentWebhookRequest(input: AgentWebhookRequestInput): Request {
  const controller = new AbortController()
  const abort = () => controller.abort(new DOMException("Client disconnected.", "AbortError"))
  if (input.node?.req?.aborted) abort()
  else input.node?.req?.once("aborted", abort)
  input.node?.res?.once("close", () => {
    if (!input.node?.res?.writableEnded) abort()
  })
  return new Request(input.url, {
    body: input.body,
    headers: input.headers,
    method: input.method,
    signal: AbortSignal.any([input.signal, controller.signal]),
  })
}
