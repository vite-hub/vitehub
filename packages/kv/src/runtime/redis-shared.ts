import type { KVListOptions, KVListPage } from "../types.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { createKVContinuations } from "./continuations.ts"

// Check existence before INCR because an existing zero must keep its current expiry.
export const redisIncrementScript = `
local existed = redis.call('EXISTS', KEYS[1])
local current = redis.call('GET', KEYS[1])
if current then
  local negative = string.sub(current, 1, 1) == '-'
  local digits = negative and string.sub(current, 2) or current
  local boundary = negative and '9007199254740992' or '9007199254740991'
  local beyond = #digits > #boundary or (#digits == #boundary and digits > boundary)
  local at_positive_boundary = not negative and digits == boundary
  if beyond or at_positive_boundary then
    return redis.error_reply('Atomic KV increment exceeds the JavaScript safe integer range.')
  end
end
local value = redis.call('INCR', KEYS[1])
if existed == 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return value
`

/** Deletes the key only when it holds ARGV[1]. Redis runs a script as one step. */
export const redisDeleteIfEqualsScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

/** Whole seconds for `EXPIRE` and `SET EX`. */
export function redisTTLSeconds(ttl: number): number {
  if (!Number.isFinite(ttl) || ttl <= 0) throw kvErrorDiagnostics.KV_INVALID_TTL()
  const seconds = Math.ceil(ttl)
  if (!Number.isSafeInteger(seconds)) throw kvErrorDiagnostics.KV_INVALID_TTL()
  return seconds
}

export function redisIncrementResult(value: unknown): number {
  const counter = Number(value)
  if (!Number.isSafeInteger(counter)) throw kvErrorDiagnostics.KV_PROVIDER_INVALID_RESPONSE({ problem: "The counter exceeds the JavaScript safe integer range." })
  return counter
}

export function escapeRedisGlob(value: string): string {
  return value.replaceAll(/([*?[\\\]])/g, "\\$1")
}

interface RedisCursor {
  cursor: string
}

interface RedisContinuation extends RedisCursor {
  keys: string[]
}

function decodeCursor(cursor?: string): RedisCursor {
  if (!cursor) return { cursor: "0" }
  try {
    // doctor-disable-next-line typescript/boundaries/no-unvalidated-deserialization -- The structural checks below validate every cursor member before use.
    // SAFETY: value remains confined to this parser until its required fields pass the checks below.
    const value = JSON.parse(decodeURIComponent(cursor)) as RedisCursor
    if (typeof value.cursor !== "string" || value.cursor.length === 0) throw kvErrorDiagnostics.KV_INVALID_CURSOR({ problem: "invalid" })
    return value
  }
  catch {
    throw kvErrorDiagnostics.KV_INVALID_CURSOR({ problem: "invalid" })
  }
}

function encodeCursor(cursor: RedisCursor): string {
  return encodeURIComponent(JSON.stringify(cursor))
}

/**
 * `listKeys()` over Redis `SCAN`. `scan` returns the next provider cursor and the matching keys, which can be more than
 * `count`. Keys beyond the page stay in this process for the next page.
 */
export function createRedisKeyLister(provider: string, scan: (cursor: string, match: string, count: number) => Promise<[string, string[]]>) {
  const maximumContinuationBytes = 1024 * 1024
  const expired = () => kvErrorDiagnostics.KV_INVALID_CURSOR({ problem: "expired" })
  const continuations = createKVContinuations<RedisContinuation>({ expired, maximumBytes: maximumContinuationBytes })

  function retainContinuation(keys: string[], providerCursor: string): Promise<string> {
    const encoder = new TextEncoder()
    const bytes = keys.reduce((total, key) => total + encoder.encode(key).byteLength, 0)
    if (bytes > maximumContinuationBytes) {
      throw kvErrorDiagnostics.KV_PROVIDER_INVALID_RESPONSE({ problem: `${provider} scan overflow exceeds the continuation size limit.` })
    }
    return continuations.retain({ cursor: providerCursor, keys }, bytes)
  }

  async function listKeys({ cursor, limit, prefix = "" }: KVListOptions): Promise<KVListPage> {
    const retained = cursor ? continuations.take(cursor) : undefined
    if (cursor && !retained && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(cursor)) {
      throw expired()
    }
    let providerCursor: string
    let keys: string[]
    if (retained) {
      providerCursor = retained.cursor
      keys = retained.keys
    }
    else {
      const state = decodeCursor(cursor)
      providerCursor = state.cursor
      const scanned = await scan(providerCursor, `${escapeRedisGlob(prefix)}*`, limit)
      providerCursor = String(scanned[0])
      if (providerCursor === state.cursor && providerCursor !== "0") {
        throw kvErrorDiagnostics.KV_PROVIDER_INVALID_RESPONSE({ problem: `${provider} scan returned a repeated pagination cursor.` })
      }
      keys = [...new Set<string>(scanned[1])]
    }
    const pageKeys = keys.slice(0, limit)
    const overflow = keys.slice(limit)
    if (overflow.length > 0) {
      return { keys: pageKeys, cursor: await retainContinuation(overflow, providerCursor) }
    }
    if (providerCursor === "0") return { keys: pageKeys }
    return { keys: pageKeys, cursor: encodeCursor({ cursor: providerCursor }) }
  }

  return { dispose: () => continuations.dispose(), listKeys }
}

interface PortableCursor {
  /** The next cursor returned by SCAN, never a cursor whose batch was already read. */
  cursor: string
  /** Keys from that batch that have not been returned yet. */
  keys: string[]
}

const maximumScanCount = 10_000

function decodePortableCursor(cursor: string): PortableCursor {
  try {
    const value: unknown = JSON.parse(decodeURIComponent(cursor))
    if (typeof value === "object" && value !== null) {
      const scan: unknown = Reflect.get(value, "cursor")
      const keys: unknown = Reflect.get(value, "keys")
      if (typeof scan === "string" && /^\d+$/.test(scan) && Array.isArray(keys) && keys.every(key => typeof key === "string")) {
        return { cursor: scan, keys }
      }
    }
  }
  catch {}
  throw kvErrorDiagnostics.KV_INVALID_CURSOR({ problem: "invalid" })
}

function encodePortableCursor(cursor: PortableCursor): string {
  return encodeURIComponent(JSON.stringify(cursor))
}

/**
 * `listKeys()` over Redis `SCAN` with a cursor that holds all its state, so another server process can read the next
 * page. Overflow keys travel with the next SCAN cursor, preserving SCAN's full-iteration guarantee even when earlier
 * pages are deleted. Like SCAN itself, a key that changes during the listing can be missed or repeated.
 */
export function createPortableRedisKeyLister(provider: string, scan: (cursor: string, match: string, count: number) => Promise<[string, string[]]>) {
  return async function listKeys({ cursor, limit, prefix = "" }: KVListOptions): Promise<KVListPage> {
    const state = cursor ? decodePortableCursor(cursor) : { cursor: "0", keys: [] }
    let next = state.cursor
    let batch = state.keys
    if (batch.length === 0) {
      const [position, found] = await scan(next, `${escapeRedisGlob(prefix)}*`, Math.min(limit, maximumScanCount))
      if (position === next && position !== "0") {
        throw kvErrorDiagnostics.KV_PROVIDER_INVALID_RESPONSE({ problem: `${provider} scan returned a repeated pagination cursor.` })
      }
      next = position
      batch = [...new Set(found)].sort()
    }
    const keys = batch.slice(0, limit)
    const overflow = batch.slice(limit)
    if (overflow.length === 0 && next === "0") return { keys }
    return { keys, cursor: encodePortableCursor({ cursor: next, keys: overflow }) }
  }
}
