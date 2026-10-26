import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"
import memoryDriver from "unstorage/drivers/memory"

import { createCloudflareKVStorage } from "../src/runtime/cloudflare-kv.ts"
import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"
import type { RuntimeStorage } from "../src/runtime/hosted-storage.ts"
import { createKVStorage } from "../src/runtime/create-storage.ts"

const factories = {
  async filesystem() {
    const base = await mkdtemp(join(tmpdir(), "vitehub-kv-clear-"))
    return {
      storage: createHostedKVStorage({ store: { driver: "fs-lite", base } }),
      cleanup: () => rm(base, { recursive: true, force: true }),
    }
  },
  async cloudflare() {
    const values = new Map<string, string>()
    const binding = {
      delete: async (key: string) => { values.delete(key) },
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value) },
      list: async ({ prefix = "" }: { prefix?: string }) => ({
        keys: [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
        list_complete: true,
      }),
    }
    // SAFETY: The Cloudflare factory supplies the RuntimeStorage methods.
    const storage = createCloudflareKVStorage({ binding }) as RuntimeStorage
    return { storage, cleanup: async () => {} }
  },
}

describe.each(Object.entries(factories))("%s KV clear", (_name, createStorage) => {
  it.each(["users", "users/", "/users", "users\\", "users::"])("clears only keys under base %j", async (base) => {
    const { storage, cleanup } = await createStorage()
    try {
      await storage.setItem("users/alice", "alice")
      await storage.setItem("users/nested/bob", "bob")
      await storage.setItem("users-other/alice", "other")
      await storage.setItem("settings", "keep")

      await storage.clear(base)

      await expect(storage.getItem("users/alice")).resolves.toBeNull()
      await expect(storage.getItem("users/nested/bob")).resolves.toBeNull()
      await expect(storage.getItem("users-other/alice")).resolves.toBe("other")
      await expect(storage.getItem("settings")).resolves.toBe("keep")

      await storage.clear()
      await expect(storage.getKeys()).resolves.toEqual([])
    }
    finally {
      await storage.dispose()
      await cleanup()
    }
  })
})

it("propagates a prefix enumeration failure without deleting keys", async () => {
  const error = new Error("listing failed")
  const driver = memoryDriver()
  driver.getKeys = () => { throw error }
  const removeItem = vi.spyOn(driver, "removeItem")
  const storage = createKVStorage(driver)

  await expect(storage.clear("users")).rejects.toBe(error)
  expect(removeItem).not.toHaveBeenCalled()
})

it("propagates a prefix deletion failure", async () => {
  const error = new Error("deletion failed")
  const driver = memoryDriver()
  const storage = createKVStorage(driver)
  await storage.setItem("users/alice", "alice")
  driver.removeItem = () => { throw error }

  await expect(storage.clear("users")).rejects.toBe(error)
  await expect(storage.getItem("users/alice")).resolves.toBe("alice")
})
