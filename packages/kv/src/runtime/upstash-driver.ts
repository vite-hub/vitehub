import createDriver from "unstorage/drivers/upstash"

import type { KVListOptions, KVListPage, ResolvedUpstashKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

interface UpstashClient {
  scan: (cursor: string, options: { count: number; match: string }) => Promise<[string, string[]]>
}

interface UpstashCursor {
  cursor: string
}

function decodeCursor(cursor?: string): UpstashCursor {
  if (!cursor) return { cursor: "0" }
  try {
    // doctor-disable-next-line typescript/boundaries/no-unvalidated-deserialization -- The structural checks below validate every cursor member before use.
    // SAFETY: value remains confined to this parser until its required fields pass the checks below.
    const value = JSON.parse(decodeURIComponent(cursor)) as UpstashCursor
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Cursor JSON crosses the HTTP boundary and needs a representation check.
    if (typeof value.cursor !== "string") throw new Error()
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
    return providerCursor === "0" ? { keys } : { keys, cursor: encodeCursor({ cursor: providerCursor }) }
  }
  return driver
}
