import createDriver from "unstorage/drivers/upstash"

import type { KVListOptions, KVListPage, ResolvedUpstashKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

interface UpstashClient {
  scan: (cursor: number, options: { count: number; match: string }) => Promise<[number, string[]]>
}

interface UpstashCursor {
  cursor: number
  pending?: string[]
}

function decodeCursor(cursor?: string): UpstashCursor {
  if (!cursor) return { cursor: 0 }
  try {
    // doctor-disable-next-line typescript/boundaries/no-unvalidated-deserialization -- The structural checks below validate every cursor member before use.
    // SAFETY: value remains confined to this parser until its required fields pass the checks below.
    const value = JSON.parse(decodeURIComponent(cursor)) as UpstashCursor
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Cursor JSON crosses the HTTP boundary and needs a representation check.
    if (!Number.isSafeInteger(value.cursor) || value.cursor < 0) throw new Error()
    if (value.pending !== undefined && !value.pending.every(key => typeof key === "string")) throw new Error()
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
  driver.listKeys = async ({ cursor, limit, prefix = "" }: KVListOptions): Promise<KVListPage> => {
    const state = decodeCursor(cursor)
    if (state.pending?.length) {
      const keys = state.pending.slice(0, limit)
      const pending = state.pending.slice(limit)
      const nextState: UpstashCursor = { cursor: state.cursor }
      if (pending.length) nextState.pending = pending
      return pending.length || state.cursor !== 0
        ? { keys, cursor: encodeCursor(nextState) }
        : { keys }
    }
    const [providerCursor, keys] = await driver.getInstance().scan(state.cursor, {
      count: limit,
      match: `${escapeRedisGlob(prefix)}*`,
    })
    const pageKeys = keys.slice(0, limit)
    const pending = keys.slice(limit)
    const nextState: UpstashCursor = { cursor: providerCursor }
    if (pending.length) nextState.pending = pending
    return providerCursor === 0 && pending.length === 0
      ? { keys: pageKeys }
      : { keys: pageKeys, cursor: encodeCursor(nextState) }
  }
  return driver
}
