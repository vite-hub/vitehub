import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"

import createDriver from "unstorage/drivers/upstash"

import type { KVListOptions, KVListPage, ResolvedUpstashKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

interface UpstashClient {
  scan: (cursor: number, options: { count: number; match: string }) => Promise<[number, string[]]>
}

interface UpstashCursor {
  cursor: number
}

function decodeCursor(cursor?: string): UpstashCursor {
  if (!cursor) return { cursor: 0 }
  try {
    // doctor-disable-next-line typescript/boundaries/no-unvalidated-deserialization -- The structural checks below validate every cursor member before use.
    // SAFETY: value remains confined to this parser until its required fields pass the checks below.
    const value = JSON.parse(decodeURIComponent(cursor)) as UpstashCursor
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Cursor JSON crosses the HTTP boundary and needs a representation check.
    if (!Number.isSafeInteger(value.cursor) || value.cursor < 0) throw new Error()
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
  const continuations = new Map<string, { bytes: number; cursor: number; keys: string[]; timeout: NodeJS.Timeout }>()
  const maximumContinuations = 32
  const maximumContinuationBytes = 1024 * 1024
  let continuationBytes = 0

  function releaseContinuation(cursor: string): void {
    const continuation = continuations.get(cursor)
    if (!continuation) return
    clearTimeout(continuation.timeout)
    continuationBytes -= continuation.bytes
    continuations.delete(cursor)
  }

  function retainContinuation(keys: string[], providerCursor: number): string {
    const bytes = keys.reduce((total, key) => total + Buffer.byteLength(key), 0)
    if (bytes > maximumContinuationBytes) {
      throw new RangeError("Upstash KV scan overflow exceeds the continuation size limit.")
    }
    while (continuationBytes + bytes > maximumContinuationBytes) {
      const oldestCursor = continuations.keys().next().value
      if (!oldestCursor) break
      releaseContinuation(oldestCursor)
    }
    const cursor = randomUUID()
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
    let providerCursor: number
    let keys: string[]
    if (retained) {
      providerCursor = retained.cursor
      keys = retained.keys
    }
    else {
      const state = decodeCursor(cursor)
      ;[providerCursor, keys] = await driver.getInstance().scan(state.cursor, {
        count: limit,
        match: `${escapeRedisGlob(prefix)}*`,
      })
    }
    const pageKeys = keys.slice(0, limit)
    const overflow = keys.slice(limit)
    const nextCursor = overflow.length > 0
      ? retainContinuation(overflow, providerCursor)
      : encodeCursor({ cursor: providerCursor })
    return providerCursor === 0 && overflow.length === 0
      ? { keys: pageKeys }
      : { keys: pageKeys, cursor: nextCursor }
  }
  return driver
}
