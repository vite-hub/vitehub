import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { kvUnsupportedOperationError } from "../src/errors.ts"
import createDenoKVDriver from "../src/runtime/deno-kv.ts"
import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"
import createUpstashKVDriver from "../src/runtime/upstash-driver.ts"

const claims = (count: number, claim: () => Promise<boolean>) => Promise.all(Array.from({ length: count }, claim))

describe("fs-lite", () => {
  let base: string
  beforeEach(async () => { base = await mkdtemp(join(tmpdir(), "vitehub-kv-set-if-absent-")) })
  afterEach(() => rm(base, { force: true, recursive: true }))

  it("lets exactly one of many concurrent calls write the key", async () => {
    const storage = createHostedKVStorage({ store: { driver: "fs-lite", base } })
    const results = await claims(20, () => storage.setIfAbsentItem!("uploads/ticket", { at: 1 }))

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await storage.getItem("uploads:ticket")).toEqual({ at: 1 })
    expect(await readFile(join(base, "uploads", "ticket"), "utf8")).toBe("{\"at\":1}")
    await storage.dispose()
  })

  it("keeps a value that set() wrote and writes again after del()", async () => {
    const storage = createHostedKVStorage({ store: { driver: "fs-lite", base } })
    await storage.setItem("invite", "first")

    expect(await storage.setIfAbsentItem!("invite", "second")).toBe(false)
    expect(await storage.getItem("invite")).toBe("first")
    await storage.removeItem("invite")
    expect(await storage.setIfAbsentItem!("invite", "second")).toBe(true)
    expect(await storage.getItem("invite")).toBe("second")
    await storage.dispose()
  })

  it("never shows a partial value to a call that lost", async () => {
    const storage = createHostedKVStorage({ store: { driver: "fs-lite", base } })
    const value = "x".repeat(8 * 1024 * 1024)
    const reads = await claims(4, async () => {
      if (await storage.setIfAbsentItem!("big", value)) return true
      expect(await readFile(join(base, "big"), "utf8")).toHaveLength(value.length)
      return false
    })

    expect(reads.filter(Boolean)).toHaveLength(1)
    expect(await readdir(base)).toEqual(["big"])
    await storage.dispose()
  })

  it("stages values inside the store and keeps staged files out of key listings", async () => {
    const storage = createHostedKVStorage({ store: { driver: "fs-lite", base } })
    await writeFile(join(base, ".unstorage-tmp-0a1b2c3d-0000-4000-8000-000000000000"), "staged")
    await storage.setIfAbsentItem!("token", 1)

    expect(await storage.getKeys()).toEqual(["token"])
    expect(await storage.listKeys({ limit: 10 })).toEqual({ keys: ["token"] })
    await storage.dispose()
  })

  it("rejects undefined instead of writing a value", async () => {
    const storage = createHostedKVStorage({ store: { driver: "fs-lite", base } })

    await expect(storage.setIfAbsentItem!("missing", undefined)).rejects.toThrow("needs a value")
    expect(await storage.hasItem("missing")).toBe(false)
    await storage.dispose()
  })

  it("rejects a key that names a directory instead of claiming it", async () => {
    const storage = createHostedKVStorage({ store: { driver: "fs-lite", base } })
    await storage.setItem("nonce:child", 1)

    await expect(storage.setIfAbsentItem!("nonce", 1)).rejects.toMatchObject({ code: "EEXIST" })
    await storage.dispose()
  })
})

describe("deno-kv", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("commits only while the key has no versionstamp", async () => {
    const data = new Map<string, unknown>()
    const writes: Array<{ expireIn?: number; value: unknown }> = []
    vi.stubGlobal("Deno", {
      openKv: async () => ({
        atomic() {
          let check: string | null | undefined
          let write: { key: string; options?: { expireIn: number }; value: unknown } | undefined
          const operation = {
            check(entry: { key: [string]; versionstamp: string | null }) {
              check = entry.versionstamp
              return operation
            },
            set([key]: [string], value: unknown, options?: { expireIn: number }) {
              write = { key, options, value }
              return operation
            },
            async commit() {
              await Promise.resolve()
              if (!write || check !== null || data.has(write.key)) return { ok: false }
              data.set(write.key, write.value)
              writes.push({ expireIn: write.options?.expireIn, value: write.value })
              return { ok: true }
            },
          }
          return operation
        },
      }),
    })
    const driver = createDenoKVDriver()
    const results = await claims(10, () => driver.setIfAbsentItem!("nonce", "\"value\"", 1.5))

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(writes).toEqual([{ expireIn: 1500, value: "\"value\"" }])
  })
})

describe("upstash", () => {
  const set = vi.fn(async (_key: string, _value: string, _options: { ex?: number; nx: true }): Promise<"OK" | null> => "OK")
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request") })) })
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  function createDriver() {
    // unstorage loads this Redis class instead of `@upstash/redis`, so the test stays offline.
    const options = {
      driver: "upstash" as const,
      token: "test",
      url: "https://example.com",
      lib: { Redis: class { set = set } },
    }
    return createUpstashKVDriver(options)
  }

  it("sends one SET NX command and reports whether Redis wrote the key", async () => {
    await expect(createDriver().setIfAbsentItem!("uploads:ticket", "1", 59.2)).resolves.toBe(true)
    expect(set).toHaveBeenCalledWith("uploads:ticket", "1", { ex: 60, nx: true })

    set.mockResolvedValueOnce(null)
    await expect(createDriver().setIfAbsentItem!("uploads:ticket", "1")).resolves.toBe(false)
    expect(set).toHaveBeenLastCalledWith("uploads:ticket", "1", { nx: true })
  })
})

describe("cloudflare-kv-binding", () => {
  it("does not offer the operation and points to D1 or a Durable Object", () => {
    const storage = createHostedKVStorage({ store: { driver: "cloudflare-kv-binding", binding: "KV" } })
    expect(storage.setIfAbsentItem).toBeUndefined()

    const error = kvUnsupportedOperationError("setIfAbsent", "default")
    expect(error.why).toContain("eventually consistent")
    expect(error.fix).toContain("D1")
    expect(error.fix).toContain("Durable Object")
  })
})
