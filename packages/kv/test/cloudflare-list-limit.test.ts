import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { describe, expect, it } from "vitest"

import { createCloudflareKVStorage } from "../src/runtime/cloudflare-kv.ts"
import { listKVKeys } from "../src/errors.ts"
import type { RuntimeStorage } from "../src/runtime/hosted-storage.ts"

function createNamespace(keys: string[]) {
  const sorted = [...keys].sort()
  const limits: number[] = []
  return {
    limits,
    delete: async () => {},
    get: async () => null,
    put: async () => {},
    list: async ({ cursor, limit }: { cursor?: string, limit: number }) => {
      limits.push(limit)
      if (limit > 1000) throw new Error(`KV GET failed: 400 Invalid key_count_limit of ${limit}. Please specify an integer less than 1000.`)
      const start = cursor ? Number(cursor) : 0
      const page = sorted.slice(start, start + limit)
      const next = start + page.length
      return next < sorted.length
        ? { cursor: String(next), keys: page.map(name => ({ name })), list_complete: false }
        : { keys: page.map(name => ({ name })), list_complete: true }
    },
  }
}

describe("Cloudflare KV list({ limit })", () => {
  it("asks the binding for at most 1000 keys and pages the rest", async () => {
    const keys = Array.from({ length: 1500 }, (_, index) => `key-${String(index).padStart(4, "0")}`)
    const namespace = createNamespace(keys)
    // SAFETY: The Cloudflare storage factory supplies the RuntimeStorage list method.
    const storage = createCloudflareKVStorage({ binding: "KV", driver: "cloudflare" }) as RuntimeStorage

    const first = await runWithActiveCloudflareEnv({ KV: namespace }, () => listKVKeys(page => storage.listKeys(page), { limit: 5000 }))
    expect(first.keys).toHaveLength(1000)
    expect(first.cursor).toBeTypeOf("string")
    const second = await runWithActiveCloudflareEnv({ KV: namespace }, () => listKVKeys(page => storage.listKeys(page), { cursor: first.cursor, limit: 5000 }))
    expect(second.cursor).toBeUndefined()
    expect([...first.keys, ...second.keys]).toEqual(keys)
    expect(Math.max(...namespace.limits)).toBe(1000)
  })
})
