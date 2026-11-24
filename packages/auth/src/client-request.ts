import { AsyncLocalStorage } from "node:async_hooks"

import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"

type ClientRequest = Pick<Request, "headers" | "url">

const inProcessOrigin = "http://localhost"
const storageKey = Symbol.for("vitehub.auth.client-request")
const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
// SAFETY: Only this module sets the key, to an AsyncLocalStorage of client requests.
const clientRequests = (runtimeGlobal[storageKey] ||= new AsyncLocalStorage<ClientRequest>()) as AsyncLocalStorage<ClientRequest>

export function runWithClientRequest<T>(request: ClientRequest, next: () => T): T {
  return clientRequests.getStore() ? next() : clientRequests.run(request, next)
}

/**
 * Nitro serves a request that the server sends to itself, such as a Nuxt `useFetch()` during server rendering, at
 * `http://localhost`, so the URL of that request does not show the origin of the page.
 */
export function clientRequest(request: ClientRequest): ClientRequest {
  const client = clientRequests.getStore()
  return client && new URL(request.url).origin === inProcessOrigin ? client : request
}

export function clientRequestOrigin(request: ClientRequest, trustProxyHeaders = false): string {
  const client = clientRequest(request)
  return trustProxyHeaders ? forwardedRequestOrigin(client) : new URL(client.url).origin
}
