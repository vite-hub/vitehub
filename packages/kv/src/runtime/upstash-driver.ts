import createDriver from "unstorage/drivers/upstash"

import type { KVListOptions, KVListPage, ResolvedUpstashKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { createKVContinuations } from "./continuations.ts"

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

function normalizeTTL(ttl: number): number {
  if (!Number.isFinite(ttl) || ttl <= 0) throw kvErrorDiagnostics.KV_R0005({ message: "Atomic KV increment requires a positive TTL in seconds." })
  const seconds = Math.ceil(ttl)
  if (!Number.isSafeInteger(seconds)) {
    throw kvErrorDiagnostics.KV_R0006({ message: "Atomic KV increment TTL exceeds the supported integer range." })
  }
  return seconds
}

interface UpstashCursor {
  cursor: string
}

interface UpstashContinuation extends UpstashCursor {
  keys: string[]
}

function decodeCursor(cursor?: string): UpstashCursor {
  if (!cursor) return { cursor: "0" }
  try {
    // doctor-disable-next-line typescript/boundaries/no-unvalidated-deserialization -- The structural checks below validate every cursor member before use.
    // SAFETY: value remains confined to this parser until its required fields pass the checks below.
    const value = JSON.parse(decodeURIComponent(cursor)) as UpstashCursor
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Cursor JSON crosses the HTTP boundary and needs a representation check.
    if (typeof value.cursor !== "string" || value.cursor.length === 0) throw kvErrorDiagnostics.KV_R0007()
    return value
  }
  catch {
    throw kvErrorDiagnostics.KV_R0008({ message: "Invalid Upstash KV cursor." })
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
  const driver = createDriver(options) as KVRuntimeDriver & { getInstance: () => Promise<UpstashClient> }
  const maximumContinuationBytes = 1024 * 1024
  const expired = () => Object.assign(kvErrorDiagnostics.KV_R0011({ message: "Invalid or expired Upstash KV cursor." }), { code: "KV_CURSOR_EXPIRED" })
  const continuations = createKVContinuations<UpstashContinuation>({ expired, maximumBytes: maximumContinuationBytes })
  const dispose = driver.dispose
  driver.dispose = async () => {
    try { await continuations.dispose() }
    finally { await dispose?.call(driver) }
  }

  driver.getAndDeleteItem = async key => (await driver.getInstance()).getdel(key)
  driver.incrementItem = async (key, ttl) => {
    const value = Number(await (await driver.getInstance()).eval(incrementScript, [key], [String(normalizeTTL(ttl))]))
    if (!Number.isSafeInteger(value)) throw kvErrorDiagnostics.KV_R0009({ message: "Atomic KV increment exceeds the JavaScript safe integer range." })
    return value
  }

  function retainContinuation(keys: string[], providerCursor: string): Promise<string> {
    const encoder = new TextEncoder()
    const bytes = keys.reduce((total, key) => total + encoder.encode(key).byteLength, 0)
    if (bytes > maximumContinuationBytes) {
      throw kvErrorDiagnostics.KV_R0010({ message: "Upstash KV scan overflow exceeds the continuation size limit." })
    }
    return continuations.retain({ cursor: providerCursor, keys }, bytes)
  }

  driver.listKeys = async ({ cursor, limit, prefix = "" }: KVListOptions): Promise<KVListPage> => {
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
      const scanned = await (await driver.getInstance()).scan(providerCursor, {
        count: limit,
        match: `${escapeRedisGlob(prefix)}*`,
      })
      providerCursor = String(scanned[0])
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
  return driver
}
