import createDriver from "unstorage/drivers/upstash"

import type { KVListOptions, KVListPage, ResolvedUpstashKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

interface UpstashClient {
  scan: (cursor: number, options: { count: number; match: string }) => Promise<[number, string[]]>
}

interface UpstashCursor {
  cursor: number
  offset?: number
}

function decodeCursor(cursor?: string): UpstashCursor {
  if (!cursor) return { cursor: 0 }
  try {
    // doctor-disable-next-line typescript/boundaries/no-unvalidated-deserialization -- The structural checks below validate every cursor member before use.
    // SAFETY: value remains confined to this parser until its required fields pass the checks below.
    const value = JSON.parse(decodeURIComponent(cursor)) as UpstashCursor
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Cursor JSON crosses the HTTP boundary and needs a representation check.
    if (!Number.isSafeInteger(value.cursor) || value.cursor < 0) throw new Error()
    if (value.offset !== undefined && (!Number.isSafeInteger(value.offset) || value.offset < 0)) throw new Error()
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
    const [providerCursor, keys] = await driver.getInstance().scan(state.cursor, {
      count: limit,
      match: `${escapeRedisGlob(prefix)}*`,
    })
    const offset = state.offset ?? 0
    if (offset > keys.length) throw new TypeError("Invalid Upstash KV cursor.")
    const pageKeys = keys.slice(offset, offset + limit)
    const nextOffset = offset + pageKeys.length
    const hasOverflow = nextOffset < keys.length
    const nextState: UpstashCursor = hasOverflow
      ? { cursor: state.cursor, offset: nextOffset }
      : { cursor: providerCursor }
    return providerCursor === 0 && !hasOverflow
      ? { keys: pageKeys }
      : { keys: pageKeys, cursor: encodeCursor(nextState) }
  }
  return driver
}
