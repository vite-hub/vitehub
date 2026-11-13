import { defineCachedFunction as defineNitroCachedFunction, defineCachedHandler as defineNitroCachedHandler } from "nitro/cache"
import { defineHandler, toResponse, type EventHandler, type H3Event } from "nitro/h3"
import { useKV } from "nitro/kv"
import type { CachedFunctionOptions as NitroCachedFunctionOptions, CachedHandlerOptions as NitroCachedHandlerOptions } from "nitro/types"
import type { CachedFunction } from "ocache"

import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

/** Tags for one cache entry: a list, or a function of the cached function's arguments. */
export type CacheTags<ArgsT extends unknown[]> = readonly string[] | ((...args: ArgsT) => readonly string[] | Promise<readonly string[]>)

/** Nitro's cached function options, plus `tags`. */
export interface CachedFunctionOptions<T = unknown, ArgsT extends unknown[] = unknown[]> extends NitroCachedFunctionOptions<T, ArgsT> {
  /** Tags for each entry. `invalidateTag()` with one of them makes the next call run the function again. */
  tags?: CacheTags<ArgsT>
}

/** Nitro's cached handler options, plus `tags`. */
export interface CachedHandlerOptions extends NitroCachedHandlerOptions {
  /** Tags for each response. The function sees the same request as the handler. */
  tags?: CacheTags<[H3Event]>
}

// The cached handler stores this header with each response. Its value is the start time and the URI-encoded tags.
const tagHeader = "x-vitehub-cache-tags"

/** Like Nitro's `defineCachedFunction()`, with `tags`. */
export function defineCachedFunction<T, ArgsT extends unknown[] = unknown[]>(
  fn: (...args: ArgsT) => T | Promise<T>,
  opts: CachedFunctionOptions<T, ArgsT> = {},
): CachedFunction<T, ArgsT> {
  const { tags, validate, ...options } = opts
  if (!tags) return defineNitroCachedFunction(fn, opts)
  // ocache gives the check before the function runs and the check before the write the same context object.
  // The first check marks the start, so a tag invalidated while the function runs keeps its result out of the cache.
  const startedAt = new WeakMap<object, number>()
  return defineNitroCachedFunction(fn, {
    ...options,
    validate: async (entry, context) => {
      let start = startedAt.get(context)
      if (start === undefined) startedAt.set(context, start = Date.now())
      const valid = validate ? await validate(entry, context) !== false : entry.value !== undefined
      return valid && await isNewerThanTags(await resolveTags(tags, context.args), Math.min(entry.mtime ?? start, start))
    },
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
  const cached = defineNitroCachedHandler(handler, tagged)
  return defineHandler(async (event) => {
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
    throw viteHubErrorDiagnostics.VITE_HUB_R0145({ message: `[vitehub] Cache tags must be non-empty strings, but got ${JSON.stringify(tags)}.` })
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

function readTagHeader(value: string | undefined): { start: number, tags: string[] } | undefined {
  if (!value) return undefined
  const [start, tags = ""] = value.split(" ")
  return { start: Number(start), tags: tags ? tags.split(",").map(decodeURIComponent) : [] }
}
