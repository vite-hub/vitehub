import createDriver from "unstorage/drivers/upstash"

import type { KVListOptions, KVListPage, ResolvedUpstashKVStoreConfig } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

interface UpstashClient {
  scan: (cursor: string, options: { count: number; match: string }) => Promise<[string, string[]]>
}

interface UpstashCursor {
  cursor: string
  pending?: string[]
}

function decodeCursor(cursor?: string): UpstashCursor {
  if (!cursor) return { cursor: "0" }
  try {
    // doctor-disable-next-line typescript/boundaries/no-unvalidated-deserialization -- The structural checks below validate every cursor member before use.
    // SAFETY: value remains confined to this parser until its required fields pass the checks below.
    const value = JSON.parse(decodeURIComponent(cursor)) as UpstashCursor
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Cursor JSON crosses the HTTP boundary and needs a representation check.
    if (typeof value.cursor !== "string" || (value.pending && !Array.isArray(value.pending))) throw new Error()
    return value
  }
  catch {
    throw new TypeError("Invalid Upstash KV cursor.")
  }
}

function encodeCursor(cursor: UpstashCursor): string {
  return encodeURIComponent(JSON.stringify(cursor))
}

export default function createUpstashKVDriver(options: ResolvedUpstashKVStoreConfig): KVRuntimeDriver {
  // SAFETY: The unstorage Upstash driver exposes getInstance and this adapter installs listKeys before returning.
  const driver = createDriver(options) as KVRuntimeDriver & { getInstance: () => UpstashClient }
  driver.listKeys = async ({ cursor, limit, prefix = "" }: KVListOptions): Promise<KVListPage> => {
    const state = decodeCursor(cursor)
    const keys = state.pending?.splice(0, limit) ?? []
    let providerCursor = state.cursor
    while (keys.length < limit && (providerCursor !== "0" || !cursor)) {
      const [nextCursor, scanned] = await driver.getInstance().scan(providerCursor, {
        count: limit - keys.length,
        match: `${prefix}*`,
      })
      providerCursor = nextCursor
      keys.push(...scanned)
      if (providerCursor === "0") break
    }
    const pageKeys = keys.slice(0, limit)
    const pending = keys.slice(limit)
    return providerCursor === "0" && pending.length === 0
      ? { keys: pageKeys }
      : { keys: pageKeys, cursor: encodeCursor({ cursor: providerCursor, ...(pending.length ? { pending } : {}) }) }
  }
  return driver
}
