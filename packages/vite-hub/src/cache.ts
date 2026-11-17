import { defineCachedFunction as defineNitroCachedFunction, defineCachedHandler as defineNitroCachedHandler } from "nitro/cache"
import { defineHandler, toResponse, type EventHandler, type H3Event } from "nitro/h3"
import { useKV } from "nitro/kv"
import type { CachedFunctionOptions as NitroCachedFunctionOptions, CachedHandlerOptions as NitroCachedHandlerOptions } from "nitro/types"
import type { CachedFunction, CacheEntry, StorageInterface } from "ocache"

import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

/** Tags for one cache entry: a list, or a function of the cached function's arguments. */
export type CacheTags<ArgsT extends unknown[]> = readonly string[] | ((...args: ArgsT) => readonly string[] | Promise<readonly string[]>)

/** Nitro's cached function options, plus `tags` and `staleIfError`. */
export interface CachedFunctionOptions<T = unknown, ArgsT extends unknown[] = unknown[]> extends NitroCachedFunctionOptions<T, ArgsT> {
  /** Tags for each entry. `invalidateTag()` with one of them makes the next call run the function again. */
  tags?: CacheTags<ArgsT>
  /**
   * Seconds after `maxAge` during which a call that throws returns the stored value instead of the error.
   * The next call runs the function again.
   */
  staleIfError?: number
}

/** Nitro's cached handler options, plus `tags`. */
export interface CachedHandlerOptions extends NitroCachedHandlerOptions {
  /** Tags for each response. The function sees the same request as the handler. */
  tags?: CacheTags<[H3Event]>
}

// The cached handler stores this header with each response. Its value is the start time and the URI-encoded tags.
const tagHeader = "x-vitehub-cache-tags"

/** Like Nitro's `defineCachedFunction()`, with `tags` and `staleIfError`. */
export function defineCachedFunction<T, ArgsT extends unknown[] = unknown[]>(
  fn: (...args: ArgsT) => T | Promise<T>,
  opts: CachedFunctionOptions<T, ArgsT> = {},
): CachedFunction<T, ArgsT> {
  const { staleIfError, ...options } = opts
  if (staleIfError !== undefined && !(typeof staleIfError === "number" && staleIfError >= 0 && Number.isFinite(staleIfError))) {
    throw viteHubErrorDiagnostics.VITE_HUB_CACHE_STALE_IF_ERROR_INVALID({ value: String(staleIfError) })
  }
  return staleIfError ? defineStaleIfErrorFunction(fn, options, staleIfError) : defineTaggedFunction(fn, options)
}

// ocache deletes an entry when the function throws, and its storage TTL ends at `maxAge`. So the function is wrapped:
// when it throws, the wrapper returns the stored value, and the storage skips writing that same value back, so the
// entry keeps its time and the next call runs the function again. The storage adds `staleIfError` to each TTL.
function defineStaleIfErrorFunction<T, ArgsT extends unknown[]>(
  fn: (...args: ArgsT) => T | Promise<T>,
  options: Omit<CachedFunctionOptions<T, ArgsT>, "staleIfError">,
  staleIfError: number,
): CachedFunction<T, ArgsT> {
  // The wrapper hides `fn` from ocache, so name and hash `fn` here the way ocache does by default.
  const name = options.name ?? (fn.name || `anon_${hashText(String(fn))}`)
  const integrity = options.integrity ?? hashText(`${fn}${JSON.stringify(options, (_key, value: unknown) => typeof value === "function" ? String(value) : value)}`)
  // Storage key to the stored value that a call returned after an error.
  const served = new Map<string, unknown>()
  const storage = (): StorageInterface => {
    const kv = useKV()
    return {
      // SAFETY: Nitro's own KV cache adapter returns what unstorage parsed, too. ocache checks the entry shape.
      get: <V>(key: string) => kv.getItem(key) as Promise<V | null>,
      set: async (key, value, opts) => {
        const stale = served.get(key)
        served.delete(key)
        // ocache writes an entry object, or null to delete one.
        if (typeof value !== "object" || (stale !== undefined && value !== null && "value" in value && value.value === stale)) return
        await kv.setItem(key, value, opts?.ttl ? { ttl: opts.ttl + staleIfError } : undefined)
      },
    }
  }
  let keysOf: (...args: ArgsT) => Promise<string[]> = async () => []
  const run = async (...args: ArgsT): Promise<T> => {
    try {
      return await fn(...args)
    } catch (error) {
      for (const key of await keysOf(...args)) {
        const entry = await useKV().getItem<CacheEntry<T>>(key)
        if (typeof entry !== "object" || entry === null) continue
        const value = await staleValue(entry, args)
        if (value === undefined) break
        if (options.onError) options.onError(error)
        else console.warn("[vitehub] The cached function threw, so it returns the stored value.", error)
        served.set(key, entry.value)
        return value
      }
      throw error
    }
  }
  const staleValue = async (entry: CacheEntry<T>, args: ArgsT): Promise<T | undefined> => {
    if (entry.integrity !== integrity || entry.value === undefined || typeof entry.mtime !== "number") return undefined
    // ocache stores `maxAge` in the entry only with `getMaxAge`. Its default is one second.
    if (Date.now() > entry.mtime + ((entry.maxAge ?? options.maxAge ?? 1) + staleIfError) * 1000) return undefined
    const decoded: CacheEntry<T> = entry.encoding === "base64" && typeof entry.value === "string"
      // SAFETY: ocache stores a cached Uint8Array as base64 text. The function returned that Uint8Array.
      ? { ...entry, encoding: undefined, value: Uint8Array.from(atob(entry.value), char => char.charCodeAt(0)) as T }
      : entry
    if (options.validate && await options.validate(decoded, { args }) === false) return undefined
    return decoded.value
  }
  const cached = defineTaggedFunction(run, { ...options, integrity, name, storage })
  keysOf = cached.resolveKeys
  return cached
}

function defineTaggedFunction<T, ArgsT extends unknown[]>(
  fn: (...args: ArgsT) => T | Promise<T>,
  opts: Omit<CachedFunctionOptions<T, ArgsT>, "staleIfError">,
): CachedFunction<T, ArgsT> {
  const { tags, validate, ...options } = opts
  if (!tags) return defineNitroCachedFunction(fn, opts)
  // ocache gives the check before the function runs and the check before the write the same context object.
  // The first check marks the start, so a tag invalidated while the function runs keeps its result out of the cache.
  const startedAt = new WeakMap<object, number>()
  const create = () => defineNitroCachedFunction(fn, {
    ...options,
    validate: async (entry, context) => {
      let start = startedAt.get(context)
      if (start === undefined) startedAt.set(context, start = Date.now())
      const valid = validate ? await validate(entry, context) !== false : entry.value !== undefined
      return valid && await isNewerThanTags(await resolveTags(tags, context.args), Math.min(entry.mtime ?? start, start))
    },
  })
  const select = tagGeneration(create)
  const initial = create()
  return Object.assign(async (...args: ArgsT) => (await select(await resolveTags(tags, args)))(...args), {
    resolveKeys: initial.resolveKeys,
    invalidate: async (...args: ArgsT) => (await select(await resolveTags(tags, args))).invalidate(...args),
    expire: async (...args: ArgsT) => (await select(await resolveTags(tags, args))).expire(...args),
  })
}

/** Like Nitro's `defineCachedHandler()`, with `tags`. */
export function defineCachedHandler(handler: EventHandler, opts: CachedHandlerOptions = {}): EventHandler {
  const { tags, shouldBypassCache, shouldCache, ...options } = opts
  if (!tags) return defineNitroCachedHandler(handler, opts)
  // ocache asks whether to bypass the cache before it looks up the entry, so that is the start time.
  const startedAt = new WeakMap<object, number>()
  const tagged: NitroCachedHandlerOptions & { toResponse: (value: unknown, event: H3Event) => Promise<Response> } = {
    ...options,
    shouldBypassCache: (event) => {
      startedAt.set(event, Date.now())
      return shouldBypassCache?.(event) ?? false
    },
    shouldCache: async (entry) => {
      if (shouldCache && await shouldCache(entry) === false) return false
      const stamp = readTagHeader(entry.headers[tagHeader])
      return !stamp || await isNewerThanTags(stamp.tags, stamp.start)
    },
    toResponse: async (value, event) => {
      const start = startedAt.get(event) ?? Date.now()
      const response = await toResponse(value, event)
      const headers = new Headers(response.headers)
      headers.set(tagHeader, `${start} ${(await resolveTags(tags, [event])).map(encodeURIComponent).join(",")}`)
      return new Response(response.body, { headers, status: response.status, statusText: response.statusText })
    },
  }
  const select = tagGeneration(() => defineNitroCachedHandler(handler, tagged))
  return defineHandler(async (event) => {
    const cached = await select(await resolveTags(tags, [event]))
    const response = await cached(event)
    if (response instanceof Response) response.headers.delete(tagHeader)
    return response
  })
}

/** Makes the next call of every cached function or handler with one of these tags run again. */
export async function invalidateTag(tags: string | readonly string[]): Promise<void> {
  const list = checkTags(typeof tags === "string" ? [tags] : tags)
  const time = Date.now()
  const storage = useKV("cache")
  await Promise.all(list.map(tag => storage.setItem(tagKey(tag), time)))
}

async function resolveTags<ArgsT extends unknown[]>(tags: CacheTags<ArgsT>, args: ArgsT): Promise<readonly string[]> {
  return checkTags(typeof tags === "function" ? await tags(...args) : tags)
}

function checkTags(tags: unknown): readonly string[] {
  if (!Array.isArray(tags) || !tags.every(tag => typeof tag === "string" && tag !== "")) {
    throw viteHubErrorDiagnostics.VITE_HUB_CACHE_TAG_INVALID({ message: `[vitehub] Cache tags must be non-empty strings, but got ${JSON.stringify(tags)}.` })
  }
  return tags
}

// One record per tag, with no TTL. The key encodes the tag, so `post` and `post:1` never share a path in fs-lite.
function tagKey(tag: string): string {
  return `tags:${encodeURIComponent(tag)}`
}

/** False when a tag was invalidated at or after `since`. Reads one record per tag, so it needs no key scan. */
async function isNewerThanTags(tags: readonly string[], since: number): Promise<boolean> {
  if (tags.length === 0) return true
  const storage = useKV("cache")
  const times = await Promise.all(tags.map(tag => storage.getItem(tagKey(tag))))
  return times.every(time => typeof time !== "number" || time < since)
}

// A short, stable hash, like the one ocache uses to name an anonymous function.
function hashText(text: string): string {
  let h1 = 0xDEADBEEF
  let h2 = 0x41C6CE57
  for (let index = 0; index < text.length; index++) {
    const char = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ char, 2654435761)
    h2 = Math.imul(h2 ^ char, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

function readTagHeader(value: string | undefined): { start: number, tags: string[] } | undefined {
  if (!value) return undefined
  const [start, tags = ""] = value.split(" ")
  return { start: Number(start), tags: tags ? tags.split(",").map(decodeURIComponent) : [] }
}

// Pending work belongs to an ocache instance. Rotate that instance when the persisted tag
// generation changes, keeping storage keys stable while separating pre-invalidation work.
// Keep only the latest instance; active calls retain their own instance until they finish.
function tagGeneration<T>(create: () => T): (tags: readonly string[]) => Promise<T> {
  let generation: string | undefined
  let current: T
  return async (tags) => {
    const storage = useKV("cache")
    const times = await Promise.all(tags.map(tag => storage.getItem(tagKey(tag))))
    const next = JSON.stringify([tags, times])
    if (next !== generation) {
      current = create()
      generation = next
    }
    return current
  }
}
