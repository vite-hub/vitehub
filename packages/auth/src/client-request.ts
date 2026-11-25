import { clientRequest } from "@vite-hub/internal/runtime/client-request"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"

type ClientRequest = Pick<Request, "headers" | "url">

export function clientRequestOrigin(request: ClientRequest, trustProxyHeaders = false): string {
  const client = clientRequest(request)
  return trustProxyHeaders ? forwardedRequestOrigin(client) : new URL(client.url).origin
}
