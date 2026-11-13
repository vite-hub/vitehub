import { getStandardContext } from "@vite-hub/runtime/internal/h3"

// A body that the response streams and the cache copy reads at different speeds is buffered in between, and a Worker
// has 128 MB of memory.
const maxBytes = 25 * 1024 * 1024

interface EdgeCache {
  match(request: Request): Promise<Response | undefined>
  put(key: string, response: Response): Promise<void>
}

/** Cloudflare's `caches`: a standard CacheStorage with its own `default` cache. */
function isCloudflareCaches(value: unknown): value is { open(name: string): Promise<EdgeCache> } {
  return typeof value === "object" && value !== null && "default" in value && "open" in value && typeof value.open === "function"
}

/**
 * The Cache API of the Cloudflare location that runs the Worker, or undefined on other hosts. Deno also has `caches`,
 * but its Cache API does not answer ranges and conditional requests.
 */
function edgeCache(): Promise<EdgeCache> | undefined {
  const storage: unknown = Reflect.get(globalThis, "caches")
  return isCloudflareCaches(storage) ? storage.open("vitehub-blob") : undefined
}

/** The cache key of one object: an address on the app's own origin that no route serves. */
export function edgeCacheKey(request: Request, store: string, pathname: string): string {
  return `${new URL(request.url).origin}/_vitehub/blob-edge-cache/${encodeURIComponent(store)}/${encodeURIComponent(pathname)}`
}

/**
 * The cached answer to a `GET`, with its range and `If-None-Match` applied by the cache: `200`, `206`, `304`, or `416`.
 * Cloudflare does not evaluate `If-Range`, so such a request reads storage.
 */
export async function matchEdgeCache(request: Request, key: string): Promise<Response | undefined> {
  if (request.method !== "GET" || request.headers.has("if-range")) return undefined
  const cache = edgeCache()
  if (!cache) return undefined
  const headers = new Headers()
  for (const name of ["range", "if-none-match"]) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  try {
    return await (await cache).match(new Request(key, { headers }))
  }
  catch {
    return undefined
  }
}

/**
 * Return `response` and keep a copy of a whole `200` body in the cache for `maxAge` seconds. The copy holds only the
 * headers of the object, so each request gets the headers of its own `serve()` options.
 */
export function keepInEdgeCache(request: Request, key: string, response: Response, maxAge: number): Response {
  const length = response.headers.get("content-length")
  if (request.method !== "GET" || response.status !== 200 || !response.body || length === null || Number(length) > maxBytes) return response
  const cache = edgeCache()
  if (!cache) return response
  const [sent, copy] = response.body.tee()
  const headers = new Headers({ "Cache-Control": `public, max-age=${maxAge}` })
  for (const name of ["content-length", "content-type", "etag"]) {
    const value = response.headers.get(name)
    if (value) headers.set(name, value)
  }
  const stored = cache.then(opened => opened.put(key, new Response(copy, { headers }))).catch(() => {})
  const waitUntil = getStandardContext(request).waitUntil
  if (waitUntil) waitUntil(stored)
  return new Response(sent, { headers: response.headers, status: response.status, statusText: response.statusText })
}
