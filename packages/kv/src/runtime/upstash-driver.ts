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
  const continuations = new Map<string, { cursor: number; keys: string[]; timeout: NodeJS.Timeout }>()
  const maximumContinuations = 32

  function releaseContinuation(cursor: string): void {
    const continuation = continuations.get(cursor)
    if (!continuation) return
    clearTimeout(continuation.timeout)
    continuations.delete(cursor)
  }

  function retainContinuation(keys: string[], providerCursor: number): string {
    const cursor = randomUUID()
    const timeout = setTimeout(() => releaseContinuation(cursor), 15 * 60_000)
    timeout.unref()
    continuations.set(cursor, { cursor: providerCursor, keys, timeout })
    while (continuations.size > maximumContinuations) {
      const oldestCursor = continuations.keys().next().value
      if (oldestCursor) releaseContinuation(oldestCursor)
    }
    return cursor
  }

  driver.listKeys = async ({ cursor, limit, prefix = "" }: KVListOptions): Promise<KVListPage> => {
    const retained = cursor ? continuations.get(cursor) : undefined
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
