import { getStandardContext } from "@vite-hub/runtime/internal/h3"

import { matchesETag, selectByteRange } from "./serve-request.ts"

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
 * Read metadata without delegating conditional or range parsing to Cloudflare. Normalize a selected range only after
 * checking If-None-Match, so cache hits follow the same rules as storage reads.
 * Cloudflare does not evaluate If-Range, so such a request reads storage.
 */
export async function matchEdgeCache(request: Request, key: string): Promise<Response | undefined> {
  if (request.method !== "GET" || request.headers.has("if-range")) return undefined
  const cache = edgeCache()
  if (!cache) return undefined
  try {
    const opened = await cache
    const whole = await opened.match(new Request(key))
    if (!whole) return undefined
    const etag = whole.headers.get("etag") ?? undefined
    if (matchesETag(request.headers.get("if-none-match"), etag)) {
      await whole.body?.cancel()
      return new Response(null, { headers: whole.headers, status: 304 })
    }
    const range = selectByteRange(request, etag, Number(whole.headers.get("content-length")))
    if (!range) return whole
    await whole.body?.cancel()
    if (range === "unsatisfiable") {
      const headers = new Headers(whole.headers)
      headers.set("Content-Range", `bytes */${whole.headers.get("content-length")}`)
      headers.set("Content-Length", "0")
      return new Response(null, { headers, status: 416 })
    }
    return await opened.match(new Request(key, { headers: { Range: `bytes=${range.start}-${range.end}` } }))
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
