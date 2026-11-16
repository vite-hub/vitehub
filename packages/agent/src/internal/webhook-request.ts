import { getStandardContext, installRequestStandardContext } from "@vite-hub/runtime/internal/h3"

export interface AgentWebhookRequestInput {
  body?: RequestInit["body"]
  /** The Request that this one copies. The copy keeps its Standard Context. */
  from?: Request
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
  const request = new Request(input.url, init)
  return input.from ? keepStandardContext(input.from, request) : request
}

/**
 * Gives `copy` the Standard Context of `request`. Code that reads the copy, such as `authenticated()`, then prepares
 * response headers for the response of the host, and not for a copy that no host sends.
 */
export function keepStandardContext(request: Request, copy: Request): Request {
  installRequestStandardContext(copy, getStandardContext(request))
  return copy
}
