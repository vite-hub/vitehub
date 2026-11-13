import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { createStorage } from "unstorage"
import { describe, expect, it, vi } from "vitest"

import { kv } from "../src/index.ts"
import createKVCacheDriver from "../src/runtime/nitro-cache.ts"

vi.mock("#vitehub/kv/config", () => ({
  hosting: "cloudflare",
  kv: { store: { binding: "KV", driver: "cloudflare-kv-binding" } },
}))

// The cache driver imports the package entry, so both share the store resolved from the mocked config.
vi.mock("@vite-hub/kv", async () => await import("../src/index.ts"))

function createNamespace() {
  const values = new Map<string, string>()
  const puts: Array<{ key: string, options?: { expirationTtl?: number } }> = []
  return {
    puts,
    values,
    delete: async (key: string) => { values.delete(key) },
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      puts.push({ key, options })
      values.set(key, value)
    },
    list: async ({ prefix = "" }: { prefix?: string }) => ({
      keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
      list_complete: true,
    }),
  }
}

describe("Nitro cache on KV", () => {
  it("stores cache entries in the app's KV store under their own prefix", async () => {
    const namespace = createNamespace()
    const storage = createStorage()
    storage.mount("cache", createKVCacheDriver())

    await runWithActiveCloudflareEnv({ KV: namespace }, async () => {
      expect(await kv.set("settings", { theme: "dark" })).toEqual([undefined, undefined])
      await storage.setItem("cache:nitro:functions:stars:repo.json", { value: 42 }, { ttl: 5 })

      // Workers KV refuses an expirationTtl under 60 seconds, so unstorage raises it.
      expect(namespace.puts.at(-1)).toMatchObject({ key: "nitro-cache:nitro:functions:stars:repo.json", options: { expirationTtl: 60 } })
      expect(await storage.getItem("cache:nitro:functions:stars:repo.json")).toEqual({ value: 42 })
      expect(await storage.hasItem("cache:nitro:functions:stars:repo.json")).toBe(true)
      expect(await storage.getKeys("cache")).toEqual(["cache:nitro:functions:stars:repo.json"])

      await storage.clear("cache")
      expect([...namespace.values.keys()]).toEqual(["settings"])
    })
  })

  it("decodes a cached value once, so cached JSON strings stay strings", async () => {
    const namespace = createNamespace()
    const storage = createStorage()
    storage.mount("cache", createKVCacheDriver())

    await runWithActiveCloudflareEnv({ KV: namespace }, async () => {
      await storage.setItem("cache:version", "\"123\"")
      await storage.setItem("cache:count", "123")
      expect(await storage.getItem("cache:version")).toBe("123")
      expect(await storage.getItem("cache:count")).toBe(123)
    })
  })

  it("returns raw entries as the bytes that were stored", async () => {
    const namespace = createNamespace()
    const storage = createStorage()
    storage.mount("cache", createKVCacheDriver())
    // A PNG's signature: 0x89 and the bytes after it aren't valid UTF-8, so reading them as text would mangle them.
    const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0x00, 0xC3])

    await runWithActiveCloudflareEnv({ KV: namespace }, async () => {
      await storage.setItemRaw("cache:og.png", bytes)
      expect(new Uint8Array(await storage.getItemRaw("cache:og.png") as Uint8Array)).toEqual(bytes)
      expect(await storage.getItemRaw("cache:missing.png")).toBeNull()
    })
  })

  it.each(["", ":", "/", ":://"])("keeps an empty normalized base %j inside the default prefix", async (base) => {
    const namespace = createNamespace()
    const storage = createStorage()
    storage.mount("cache", createKVCacheDriver({ base }))

    await runWithActiveCloudflareEnv({ KV: namespace }, async () => {
      await kv.set("settings", { theme: "dark" })
      await storage.setItem("cache:settings", { cached: true })
      expect(await kv.get("settings")).toEqual([undefined, { theme: "dark" }])
      expect(await storage.getKeys("cache")).toEqual(["cache:settings"])
      await storage.clear("cache")
      expect([...namespace.values.keys()]).toEqual(["settings"])
    })
  })

  it("uses a custom prefix", async () => {
    const namespace = createNamespace()
    const storage = createStorage()
    storage.mount("cache", createKVCacheDriver({ base: "pages" }))

    await runWithActiveCloudflareEnv({ KV: namespace }, async () => {
      await storage.setItem("cache:nitro:handlers:home.json", { body: "hi" })
      await storage.removeItem("cache:nitro:handlers:other.json")
    })

    expect(namespace.puts.map(put => put.key)).toEqual(["pages:nitro:handlers:home.json"])
  })

  it("throws the KV error so Nitro reports it", async () => {
    const storage = createStorage()
    storage.mount("cache", createKVCacheDriver())

    await expect(storage.getItem("cache:nitro:functions:x.json")).rejects.toThrow()
  })
})
