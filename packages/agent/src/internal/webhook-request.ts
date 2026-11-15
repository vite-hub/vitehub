export interface AgentWebhookRequestInput {
  body?: RequestInit["body"]
  headers?: RequestInit["headers"]
  method: string
  signal?: AbortSignal
  url: string | URL
}

export function createAgentWebhookRequest(input: AgentWebhookRequestInput): Request {
  const init: RequestInit & { duplex?: "half" } = {
    body: input.body,
    headers: input.headers,
    method: input.method,
    signal: input.signal,
  }
  if (input.body != null) init.duplex = "half"
  return new Request(input.url, init)
}
