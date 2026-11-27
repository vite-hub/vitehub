import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { normalizeKVOptions } from "../src/config.ts"
import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"
import type { ResolvedFsLiteKVStoreConfig } from "../src/types.ts"

it("gives each named fs-lite store without a base its own folder", async () => {
  const config = normalizeKVOptions({
    stores: {
      cache: { driver: "fs-lite" },
      default: { driver: "fs-lite" },
      sessions: { driver: "fs-lite" },
    },
  }, { env: {}, hosting: "" })

  const root = await mkdtemp(join(tmpdir(), "vitehub-kv-named-"))
  // SAFETY: Every store above sets the fs-lite driver.
  const stores = config!.stores as Record<string, ResolvedFsLiteKVStoreConfig>
  const open = (name: string) => createHostedKVStorage({ store: { ...stores[name]!, base: join(root, stores[name]!.base) } })
  const cache = open("cache")
  const sessions = open("sessions")
  const defaultStore = open("default")
  try {
    await cache.setItem("user", "from-cache")
    await defaultStore.setItem("user", "from-default")
    await expect(sessions.getItem("user")).resolves.toBeNull()
    await expect(sessions.getKeys()).resolves.toEqual([])
    await sessions.clear()
    await expect(cache.getItem("user")).resolves.toBe("from-cache")
    await expect(defaultStore.getItem("user")).resolves.toBe("from-default")
    await expect(defaultStore.getKeys()).resolves.toEqual(["user"])
  }
  finally {
    await Promise.all([cache.dispose(), sessions.dispose(), defaultStore.dispose()])
    await rm(root, { force: true, recursive: true })
  }
  expect(config?.stores).toEqual({
    cache: { base: ".vitehub/data/kv-stores/cache", driver: "fs-lite" },
    default: { base: ".vitehub/data/kv", driver: "fs-lite" },
    sessions: { base: ".vitehub/data/kv-stores/sessions", driver: "fs-lite" },
  })
})

it("keeps every store name in one folder segment", () => {
  const config = normalizeKVOptions({
    stores: {
      "": { driver: "fs-lite" },
      "..": { driver: "fs-lite" },
      "a/b": { driver: "fs-lite" },
      "default": { driver: "fs-lite" },
    },
  }, { env: {}, hosting: "" })
  expect(config?.stores?.[""]).toEqual({ base: ".vitehub/data/kv-stores/%", driver: "fs-lite" })
  expect(config?.stores?.[".."]).toEqual({ base: ".vitehub/data/kv-stores/%2E%2E", driver: "fs-lite" })
  expect(config?.stores?.["a/b"]).toEqual({ base: ".vitehub/data/kv-stores/a%2Fb", driver: "fs-lite" })
})
