import { createHash } from "node:crypto"

/** A response body that a later request can revalidate with `If-None-Match`. */
export interface ForgeCachedResponse {
  etag: string
  body: string
  /** The headers that a `304` does not repeat, such as `content-type` and `link`. */
  headers: [string, string][]
}

/** Where conditional requests keep their validators and bodies. Keys are opaque hashes. */
export interface ForgeResponseCache {
  get(key: string): ForgeCachedResponse | undefined
  set(key: string, value: ForgeCachedResponse): void
  delete(key: string): void
}

export interface ForgeConditionalRequests {
  /**
   * Who may reuse an entry. Default: the request's `Authorization` header. Pass something stable such as
   * `app:<appId>:<installationId>` so a rotated installation token keeps the entries of the one before it.
   */
  identity?: string
  /** Default: one in-memory cache shared by every provider in the process. */
  cache?: ForgeResponseCache
}

export interface ForgeMemoryCacheOptions {
  /** Default 32 MiB, counted in body characters. */
  maxSize?: number
  /** Bodies larger than this are not kept. Default 1 MiB. */
  maxEntrySize?: number
}

const storedHeaders = ["content-type", "link", "last-modified"]
const bodyHeaders = ["content-length", "content-encoding", "transfer-encoding"]

/** An in-memory LRU of Forge responses, bounded by the total size of the bodies it keeps. */
export function forgeMemoryCache(options: ForgeMemoryCacheOptions = {}): ForgeResponseCache {
  const maxSize = options.maxSize ?? 32 * 1024 * 1024
  const maxEntrySize = options.maxEntrySize ?? 1024 * 1024
  const entries = new Map<string, ForgeCachedResponse>()
  let size = 0
  const remove = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    size -= entry.body.length
  }
  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key)
      entries.set(key, entry)
      return entry
    },
    set(key, value) {
      remove(key)
      if (value.body.length > maxEntrySize) return
      entries.set(key, value)
      size += value.body.length
      while (size > maxSize) remove(entries.keys().next().value!)
    },
    delete: remove,
  }
}

const sharedCache = forgeMemoryCache()

/**
 * Wrap `fetch` so authenticated GETs send `If-None-Match` with the ETag of the last response, and a `304`
 * returns that response's body again. GitHub does not count a `304` against the primary rate limit.
 * Every read still reaches the Forge, so a cached body is only returned when the Forge says it is current.
 */
export function conditionalFetch(fetcher: typeof fetch, options: ForgeConditionalRequests = {}): typeof fetch {
  const cache = options.cache ?? sharedCache
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase()
    const headers = new Headers(request?.headers)
    for (const [name, value] of new Headers(init?.headers)) headers.set(name, value)
    const authorization = headers.get("authorization")
    // Callers that send their own validator handle the 304 themselves. Without credentials GitHub charges the 304.
    if (method !== "GET" || !authorization || headers.has("if-none-match") || headers.has("if-modified-since")) return await fetcher(input, init)
    const url = request?.url ?? String(input)
    const key = createHash("sha256").update(`${options.identity ?? authorization}\0${url}\0${headers.get("accept") ?? ""}`).digest("base64url")
    const cached = cache.get(key)
    if (cached) headers.set("if-none-match", cached.etag)
    const response = await fetcher(input, { ...init, headers })
    if (response.status === 304 && cached) {
      const merged = new Headers(cached.headers)
      for (const [name, value] of response.headers) {
        if (!bodyHeaders.includes(name)) merged.set(name, value)
      }
      return new Response(cached.body, { status: 200, statusText: "OK", headers: merged })
    }
    const etag = response.headers.get("etag")
    if (response.status !== 200 || !etag || response.redirected || !response.headers.get("content-type")?.includes("json")) {
      if (cached) cache.delete(key)
      return response
    }
    const body = await response.text()
    cache.set(key, { etag, body, headers: storedHeaders.flatMap(name => {
      const value = response.headers.get(name)
      return value === null ? [] : [[name, value] as [string, string]]
    }) })
    const copy = new Headers(response.headers)
    for (const name of bodyHeaders) copy.delete(name)
    return new Response(body, { status: response.status, statusText: response.statusText, headers: copy })
  }
}
