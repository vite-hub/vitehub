import { AsyncLocalStorage } from "node:async_hooks"

type RequestOrigin = Pick<Request, "headers" | "url">

const clientRequests = new AsyncLocalStorage<RequestOrigin>()

/**
 * Runs `next` with `request` as the request that the client sent. A request that the server serves in process while
 * `next` runs, such as a Nuxt `useFetch()` during server rendering, keeps the first client request.
 */
export function runWithClientRequest<T>(request: RequestOrigin, next: () => T): T {
  return clientRequests.getStore() ? next() : clientRequests.run(request, next)
}

/**
 * The request that the client sent for `request`. Nuxt serves a `useFetch()` of server rendering in process at
 * `http://localhost`, so the URL of that request does not show the origin of the page.
 */
export function clientRequest(request: RequestOrigin): RequestOrigin {
  return clientRequests.getStore() ?? request
}
