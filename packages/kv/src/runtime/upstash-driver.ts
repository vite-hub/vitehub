import createDriver from "unstorage/drivers/upstash"

import type { KVListOptions, KVListPage, ResolvedUpstashKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

interface UpstashClient {
  eval: (script: string, keys: string[], args: string[]) => Promise<number>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This models the caller-typed Upstash read command used by the unstorage adapter.
  getdel: <T = unknown>(key: string) => Promise<T | null>
  scan: (cursor: string, options: { count: number; match: string }) => Promise<[number | string, string[]]>
}

// Check existence before INCR because an existing zero must keep its current expiry.
const incrementScript = `
local existed = redis.call('EXISTS', KEYS[1])
local current = redis.call('GET', KEYS[1])
local numeric = current and tonumber(current)
if numeric and (numeric >= 9007199254740991 or numeric < -9007199254740992) then
  return redis.error_reply('Atomic KV increment exceeds the JavaScript safe integer range.')
end
local value = redis.call('INCR', KEYS[1])
if existed == 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return value
`

function normalizeTTL(ttl: number): number {
  if (!Number.isFinite(ttl) || ttl <= 0) throw new TypeError("Atomic KV increment requires a positive TTL in seconds.")
  return Math.ceil(ttl)
}

interface UpstashCursor {
  cursor: string
}

interface UpstashContinuation extends UpstashCursor {
  bytes: number
  keys: string[]
  timeout: ReturnType<typeof setTimeout>
}

function decodeCursor(cursor?: string): UpstashCursor {
  if (!cursor) return { cursor: "0" }
  try {
    // doctor-disable-next-line typescript/boundaries/no-unvalidated-deserialization -- The structural checks below validate every cursor member before use.
    // SAFETY: value remains confined to this parser until its required fields pass the checks below.
    const value = JSON.parse(decodeURIComponent(cursor)) as UpstashCursor
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Cursor JSON crosses the HTTP boundary and needs a representation check.
    if (typeof value.cursor !== "string" || value.cursor.length === 0) throw new Error()
    return value
  }
  catch {
    throw new TypeError("Invalid Upstash KV cursor.")
  }
}

function encodeCursor(cursor: UpstashCursor): string {
  return encodeURIComponent(JSON.stringify(cursor))
}

function escapeRedisGlob(value: string): string {
  return value.replaceAll(/([*?[\\\]])/g, "\\$1")
}

export default function createUpstashKVDriver(options: ResolvedUpstashKVStoreConfig): KVRuntimeDriver {
  // SAFETY: The unstorage Upstash driver exposes getInstance and this adapter installs listKeys before returning.
  const driver = createDriver(options) as KVRuntimeDriver & { getInstance: () => UpstashClient }
  const continuations = new Map<string, UpstashContinuation>()
  const maximumContinuations = 32
  const maximumContinuationBytes = 1024 * 1024
  let continuationBytes = 0

  driver.getAndDeleteItem = async key => driver.getInstance().getdel(key)
  driver.incrementItem = async (key, ttl) => {
    const value = Number(await driver.getInstance().eval(incrementScript, [key], [String(normalizeTTL(ttl))]))
    if (!Number.isSafeInteger(value)) throw new RangeError("Atomic KV increment exceeds the JavaScript safe integer range.")
    return value
  }

  function releaseContinuation(cursor: string): void {
    const continuation = continuations.get(cursor)
    if (!continuation) return
    clearTimeout(continuation.timeout)
    continuationBytes -= continuation.bytes
    continuations.delete(cursor)
  }

  function retainContinuation(keys: string[], providerCursor: string): string {
    const encoder = new TextEncoder()
    const bytes = keys.reduce((total, key) => total + encoder.encode(key).byteLength, 0)
    if (bytes > maximumContinuationBytes) {
      throw new RangeError("Upstash KV scan overflow exceeds the continuation size limit.")
    }
    while (continuationBytes + bytes > maximumContinuationBytes) {
      const oldestCursor = continuations.keys().next().value
      if (!oldestCursor) break
      releaseContinuation(oldestCursor)
    }
    const cursor = globalThis.crypto.randomUUID()
    const timeout = setTimeout(() => releaseContinuation(cursor), 15 * 60_000)
    // SAFETY: Node timers expose unref while web-runtime timers are numbers; the optional call keeps both hosts valid.
    ;(timeout as { unref?: () => void }).unref?.()
    continuations.set(cursor, { bytes, cursor: providerCursor, keys, timeout })
    continuationBytes += bytes
    while (continuations.size > maximumContinuations) {
      const oldestCursor = continuations.keys().next().value
      if (oldestCursor) releaseContinuation(oldestCursor)
    }
    return cursor
  }

  driver.listKeys = async ({ cursor, limit, prefix = "" }: KVListOptions): Promise<KVListPage> => {
    const retained = cursor ? continuations.get(cursor) : undefined
    if (cursor && !retained && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(cursor)) {
      throw Object.assign(new TypeError("Invalid or expired Upstash KV cursor."), { code: "KV_CURSOR_EXPIRED" })
    }
    if (retained && cursor) releaseContinuation(cursor)
    let providerCursor: string
    let keys: string[]
    if (retained) {
      providerCursor = retained.cursor
      keys = retained.keys
    }
    else {
      const state = decodeCursor(cursor)
      providerCursor = state.cursor
      const scanned = await driver.getInstance().scan(providerCursor, {
        count: limit,
        match: `${escapeRedisGlob(prefix)}*`,
      })
      providerCursor = String(scanned[0])
      keys = [...new Set<string>(scanned[1])]
    }
    const pageKeys = keys.slice(0, limit)
    const overflow = keys.slice(limit)
    if (overflow.length > 0) {
      return { keys: pageKeys, cursor: retainContinuation(overflow, providerCursor) }
    }
    if (providerCursor === "0") return { keys: pageKeys }
    return { keys: pageKeys, cursor: encodeCursor({ cursor: providerCursor }) }
  }
  return driver
}
