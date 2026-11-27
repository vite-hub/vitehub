import { AsyncLocalStorage } from "node:async_hooks"

import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"

type ClientRequest = Pick<Request, "headers" | "url">

const storageKey = Symbol.for("vitehub.auth.client-request")
const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
// SAFETY: Only this module sets the key, to an AsyncLocalStorage of client requests.
const clientRequests = (runtimeGlobal[storageKey] ||= new AsyncLocalStorage<ClientRequest>()) as AsyncLocalStorage<ClientRequest>

function isRelativeInProcessRequest(request: ClientRequest, client: ClientRequest): boolean {
  const url = new URL(request.url)
  if (url.protocol !== "http:") return false
  if (url.host === "localhost") return true
  const clientUrl = new URL(client.url)
  url.protocol = clientUrl.protocol
  return url.host === clientUrl.host
}

export function runWithClientRequest<T>(request: ClientRequest, next: () => T): T {
  const client = clientRequests.getStore()
  return client && isRelativeInProcessRequest(request, client) ? next() : clientRequests.run(request, next)
}

/**
 * Nitro builds a relative request that the server sends to itself, such as a Nuxt `useFetch()` during server rendering
 * or `serverFetch("/api/...")`, at `http://localhost` or `http://<forwarded Host>`, so the URL of that request does not
 * show the origin of the page.
 */
export function clientRequest(request: ClientRequest): ClientRequest {
  const client = clientRequests.getStore()
  return client && isRelativeInProcessRequest(request, client) ? client : request
}

export function clientRequestOrigin(request: ClientRequest, trustProxyHeaders = false): string {
  const client = clientRequest(request)
  return trustProxyHeaders ? forwardedRequestOrigin(client) : new URL(client.url).origin
}
