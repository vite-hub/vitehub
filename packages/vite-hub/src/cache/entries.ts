import { redactInspectionText } from "@vite-hub/internal/inspect"

import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

/** Default and largest page of `cache.list`. Each listed entry is one storage read, so a page stays small. */
export const cacheDefaultListLimit = 50
export const cacheMaximumListLimit = 100
/** Largest number of entries that one `cache.delete` with a prefix removes. Run it again to remove more. */
export const cacheMaximumDeleteCount = 1_000
/** `cache.get` cuts the value text at this size. */
const maximumValueBytes = 256 * 1_024
const maximumKeyLength = 2_048

/** The part of Nitro's `useStorage("cache")` that the `cache.*` operations read and change. */
export interface CacheStorage {
  getItem(key: string): Promise<unknown>
  getKeys(base?: string): Promise<string[]>
  hasItem(key: string): Promise<boolean>
  removeItem(key: string): Promise<void>
}

/** One entry of Nitro's `cache` mount, as `defineCachedFunction()` and `defineCachedHandler()` write it. */
export interface CacheEntrySummary {
  /** When the entry expires, as an ISO date. Absent when the entry has no `maxAge`. */
  expires?: string
  /** Whether `expires` is in the past. Nitro computes the value again on the next call. */
  expired: boolean
  /** `functions` for `defineCachedFunction()`, `handlers` for `defineCachedHandler()`, or the custom `group`. */
  group: string
  /** The key in the `cache` mount. Pass it to `cache.get` and `cache.delete`. */
  key: string
  /** When the value was computed, as an ISO date. */
  mtime?: string
  /** The `name` option of the cached function or handler, or the function name. */
  name: string
  /** Size of the stored entry in bytes, as JSON. */
  size: number
}

export interface CacheListResult {
  /** Present when more entries exist. Pass it as `cursor` to read the next page. */
  cursor?: string
  entries: CacheEntrySummary[]
  limit: number
  prefix: string
}

export interface CacheGetResult {
  entry?: CacheEntrySummary
  found: boolean
  key: string
  /** The value was cut at 256 KiB. */
  truncated?: true
  /** The cached value as JSON text. */
  value?: string
}

export interface CacheDeleteResult {
  /** Number of entries that the call removed. */
  deleted: number
  /** The key that the call removed. */
  key?: string
  /** `true` when more entries match the prefix. Run the call again. */
  more?: true
  /** The prefix that the call matched. */
  prefix?: string
}

function invalidInput(message: string) {
  return Object.assign(viteHubErrorDiagnostics.CACHE_INVALID_INPUT({ message }), { status: 400 })
}

/** Read the cache with the error of the driver, such as a driver that cannot list keys. */
async function readCache<T>(action: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw Object.assign(viteHubErrorDiagnostics.CACHE_STORAGE_FAILED({ message: redactInspectionText(`The cache storage could not ${action}. ${reason}`) }), { status: 502 })
  }
}

/** Unstorage keys use `:` as the separator, also for `/`, as `useStorage()` stores them. */
function normalizeCacheKey(key: string): string {
  return key.replaceAll(/[/\\]/g, ":").replaceAll(/:+/g, ":").replaceAll(/^:|:$/g, "")
}

function requireKey(key: string, label: string): string {
  if (key.length > maximumKeyLength) throw invalidInput(`The ${label} is too long.`)
  const normalized = normalizeCacheKey(key)
  // A prefix separator narrows the match to this segment; separator-only input must still be empty.
  return label === "prefix" && normalized && /[:/\\]$/.test(key) ? `${normalized}:` : normalized
}

/**
 * The group and name of a key such as `nitrofunctions.<hash>:getStars:<hash>.json`. The cache library removes other
 * characters than letters, digits, and `_` from a segment, and adds a hash when it removed some.
 */
function describeCacheKey(key: string): { group: string, name: string } {
  const segments = key.split(":")
  if (segments.length < 3) return { group: "", name: "" }
  const readable = (segment: string) => segment.replace(/\.[^.]*$/, "")
  const group = readable(segments[0]!)
  return { group: group.startsWith("nitro") && group !== "nitro" ? group.slice("nitro".length) : group, name: readable(segments[1]!) }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

function isoDate(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  }
  catch {
    return String(value)
  }
}

function describeEntry(key: string, stored: unknown): CacheEntrySummary {
  const entry = record(stored)
  const expires = isoDate(entry?.expires)
  const mtime = isoDate(entry?.mtime)
  return {
    ...describeCacheKey(key),
    ...(expires ? { expires } : {}),
    expired: typeof entry?.expires === "number" && entry.expires < Date.now(),
    key,
    ...(mtime ? { mtime } : {}),
    size: new TextEncoder().encode(typeof stored === "string" ? stored : jsonText(stored)).byteLength,
  }
}

async function matchingKeys(storage: CacheStorage, prefix: string): Promise<string[]> {
  // Unstorage reads a base as whole key segments, so `nitrohandlers` would only match `nitrohandlers:*`. The storage lists
  // the segments before the last `:`, and the prefix filters the rest.
  const base = prefix.slice(0, prefix.lastIndexOf(":") + 1)
  const keys = await readCache("list its keys", () => storage.getKeys(base))
  return keys.map(normalizeCacheKey).filter(key => key.startsWith(prefix)).sort()
}

/** One page of cache entries in key order. The cursor is the last key of the previous page. */
export async function listCacheEntries(storage: CacheStorage, input: { cursor?: string, limit?: number, prefix?: string }): Promise<CacheListResult> {
  const limit = input.limit ?? cacheDefaultListLimit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > cacheMaximumListLimit) {
    throw invalidInput(`limit must be an integer from 1 to ${cacheMaximumListLimit}.`)
  }
  const prefix = requireKey(input.prefix ?? "", "prefix")
  const cursor = input.cursor ? requireKey(input.cursor, "cursor") : undefined
  const keys = (await matchingKeys(storage, prefix)).filter(key => cursor === undefined || key > cursor)
  const page = keys.slice(0, limit)
  const entries = await Promise.all(page.map(async key => describeEntry(key, await readCache("read an entry", () => storage.getItem(key)))))
  return {
    ...(keys.length > limit ? { cursor: page.at(-1)! } : {}),
    entries,
    limit,
    prefix,
  }
}

/** One cache entry with its value as JSON text of at most 256 KiB. */
export async function getCacheEntry(storage: CacheStorage, input: { key: string }): Promise<CacheGetResult> {
  const key = requireKey(input.key, "key")
  if (!key) throw invalidInput("Name a cache key.")
  const stored = await readCache("read the entry", () => storage.getItem(key))
  if (stored === null || stored === undefined) return { found: false, key }
  const entry = record(stored)
  const value = jsonText(entry && "value" in entry ? entry.value : stored)
  const bytes = new TextEncoder().encode(value)
  const truncated = bytes.byteLength > maximumValueBytes
  return {
    entry: describeEntry(key, stored),
    found: true,
    key,
    ...(truncated ? { truncated: true as const } : {}),
    value: truncated ? new TextDecoder().decode(bytes.subarray(0, maximumValueBytes)) : value,
  }
}

/**
 * Remove one entry, or the entries whose keys start with a prefix, at most 1,000 per call. Nitro computes a removed
 * value again on the next call. There is no call that clears the whole cache.
 */
export async function deleteCacheEntries(storage: CacheStorage, input: { key?: string, prefix?: string }): Promise<CacheDeleteResult> {
  if (input.key !== undefined && input.prefix !== undefined) throw invalidInput("Pass a key or a prefix, not both.")
  if (input.key === undefined && input.prefix === undefined) throw invalidInput("Pass a key or a prefix.")
  if (input.key !== undefined) {
    const key = requireKey(input.key, "key")
    if (!key) throw invalidInput("Name a cache key.")
    const found = await readCache("read the entry", () => storage.hasItem(key))
    if (found) await readCache("remove the entry", () => storage.removeItem(key))
    return { deleted: found ? 1 : 0, key }
  }
  const prefix = requireKey(input.prefix!, "prefix")
  if (!prefix) throw invalidInput("Name a prefix. There is no operation that clears the whole cache.")
  const keys = await matchingKeys(storage, prefix)
  const removed = keys.slice(0, cacheMaximumDeleteCount)
  for (const key of removed) await readCache("remove an entry", () => storage.removeItem(key))
  return { deleted: removed.length, ...(keys.length > removed.length ? { more: true as const } : {}), prefix }
}
