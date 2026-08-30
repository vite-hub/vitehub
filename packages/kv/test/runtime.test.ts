import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createStorage } from "unstorage"
import type { Driver } from "unstorage"
import memoryDriver from "unstorage/drivers/memory"

import type { KVResult } from "../src/types.ts"

function expectKVSuccess<TResult>(result: KVResult<TResult>): TResult {
  const [error, value] = result
  expect(error).toBeNull()
  // SAFETY: The preceding assertion verifies the success branch of KVResult.
  return value as TResult
}

const mountedDrivers: {
  cloudflare?: Record<string, unknown>
  fsLite?: Record<string, unknown>
  upstash?: Record<string, unknown>
} = {}

let cloudflareDriver: Driver | undefined
let fsLiteDriver: Driver | Error | undefined
let upstashScan: ReturnType<typeof vi.fn> | undefined
// SAFETY: Tests install and restore an optional Deno runtime shim on globalThis.
const originalDeno = (globalThis as typeof globalThis & { Deno?: unknown }).Deno

function resetStorage() {
  cloudflareDriver = undefined
  fsLiteDriver = undefined
  delete mountedDrivers.cloudflare
  delete mountedDrivers.fsLite
  delete mountedDrivers.upstash
  upstashScan = undefined
}

function createInspectableDriver(name: "upstash") {
  return (options: Record<string, unknown> = {}) => {
    mountedDrivers[name] = options
    return memoryDriver()
  }
}

function createDriverWithoutOptionalMethods(): Driver {
  const data = new Map<string, unknown>()

  // SAFETY: This fixture implements every required Driver method below.
  return {
    name: "minimal",
    options: {},
    async clear(base = "") {
      for (const key of data.keys()) {
        if (key.startsWith(base)) data.delete(key)
      }
    },
    async getItem(key) {
      return data.has(key) ? data.get(key) : null
    },
    async getKeys(base = "") {
      return Array.from(data.keys()).filter(key => key.startsWith(base))
    },
    async hasItem(key) {
      return data.has(key)
    },
    async removeItem(key) {
      data.delete(key)
    },
    async setItem(key, value) {
      data.set(key, value)
    },
  } as Driver
}

function createDenoOpenKvMock() {
  const data = new Map<string, unknown>()
  const close = vi.fn()
  const openKv = vi.fn(async () => ({
    close,
    delete: async ([key]: [string]) => {
      data.delete(key)
    },
    get: async ([key]: [string]) => ({
      // SAFETY: The mock accepts and returns the single-string key shape used by this adapter.
      key: [key] as [string],
      value: data.has(key) ? data.get(key) : null,
      versionstamp: data.has(key) ? "00000000000000010000" : null,
    }),
    list: async function* () {
      for (const [key, value] of data) {
        // SAFETY: Mock data keys are strings and the adapter reads a one-element Deno tuple.
        yield { key: [key] as [string], value }
      }
    },
    set: async ([key]: [string], value: unknown) => {
      data.set(key, value)
    },
  }))

  return { close, data, openKv }
}

vi.mock("unstorage/drivers/fs-lite", () => ({
  default: vi.fn((options: Record<string, unknown> = {}) => {
    mountedDrivers.fsLite = options
    if (fsLiteDriver instanceof Error) throw fsLiteDriver
    return fsLiteDriver || memoryDriver()
  }),
}))

vi.mock("@vite-hub/kv/runtime/upstash-driver", () => ({
  default: vi.fn(createInspectableDriver("upstash")),
}))

vi.mock("unstorage/drivers/cloudflare-kv-binding", () => ({
  default: vi.fn((options: Record<string, unknown> = {}) => {
    mountedDrivers.cloudflare = options
    return cloudflareDriver || memoryDriver()
  }),
}))

vi.mock("unstorage/drivers/upstash", () => ({
  default: vi.fn(() => ({
    ...memoryDriver(),
    getInstance: () => ({ scan: upstashScan }),
  })),
}))

describe("kv runtime", () => {
  beforeEach(async () => {
    vi.resetModules()
    resetStorage()
    // SAFETY: Tests install and restore an optional Deno runtime shim on globalThis.
    ;(globalThis as typeof globalThis & { Deno?: unknown }).Deno = originalDeno
  })

  afterEach(() => {
    delete process.env.KV_REST_API_URL
    delete process.env.KV_REST_API_TOKEN
    delete process.env.VITEHUB_HOSTING
    // SAFETY: Tests install and restore an optional Deno runtime shim on globalThis.
    ;(globalThis as typeof globalThis & { Deno?: unknown }).Deno = originalDeno
  })

  it("returns provider failures as KV results", async () => {
    process.env.VITEHUB_HOSTING = "local"
    const cause = new Error("provider unavailable")
    // SAFETY: The fixture extends a complete minimal Driver with the optional methods under test.
    fsLiteDriver = {
      ...memoryDriver(),
      async getItem() { throw cause },
    }
    const { kv } = await import("../src/runtime/storage.ts")

    const [error, value] = await kv.get("settings")

    expect(value).toBeUndefined()
    expect(error).toMatchObject({
      cause,
      code: "KV_OPERATION_FAILED",
      details: { operation: "get", store: "default" },
      name: "ViteHubError",
    })
  })

  it("returns provider initialization failures as KV results", async () => {
    process.env.VITEHUB_HOSTING = "local"
    const cause = new Error("provider initialization unavailable")
    fsLiteDriver = cause
    const { kv } = await import("../src/runtime/storage.ts")

    const [error, value] = await kv.get("settings")

    expect(value).toBeUndefined()
    expect(error).toMatchObject({
      cause,
      code: "KV_OPERATION_FAILED",
      details: { operation: "get", store: "default" },
      name: "ViteHubError",
    })
  })

  it("falls back to hosted env config when the generated config import cannot load", async () => {
    process.env.KV_REST_API_URL = "https://upstash.example.com"
    process.env.KV_REST_API_TOKEN = "upstash-token"

    const { kv } = await import("../src/runtime/storage.ts")
    expectKVSuccess(await kv.set("notes/hello", "world"))

    expect(expectKVSuccess(await kv.get("notes/hello"))).toBe("world")
    expect(mountedDrivers.upstash).toMatchObject({
      driver: "upstash",
      token: "upstash-token",
      url: "https://upstash.example.com",
    })
  })

  it("honors explicit hosting before ambient Deno KV detection", async () => {
    process.env.VITEHUB_HOSTING = "local"
    const { openKv } = createDenoOpenKvMock()
    // SAFETY: This test provides the only Deno API used by the runtime adapter.
    ;(globalThis as typeof globalThis & { Deno?: unknown }).Deno = { openKv }

    const { kv } = await import("../src/runtime/storage.ts")
    expectKVSuccess(await kv.set("explicit-host", "fs-lite"))

    expect(expectKVSuccess(await kv.get("explicit-host"))).toBe("fs-lite")
    expect(mountedDrivers.fsLite).toMatchObject({
      base: ".vitehub/data/kv",
      driver: "fs-lite",
    })
    expect(openKv).not.toHaveBeenCalled()
  })

  it("does not make the lazy driver thenable", async () => {
    const { createLazyKVRuntimeDriver } = await import("../src/runtime/driver.ts")
    // SAFETY: The test inspects optional Driver properties that are intentionally outside the lazy driver's declared contract.
    const driver = createLazyKVRuntimeDriver({
      store: {
        binding: "KV",
        driver: "cloudflare-kv-binding",
      },
    })

    const resolved = await Promise.race([
      Promise.resolve(driver).then(value => ({ status: "resolved", value })),
      new Promise(resolve => setTimeout(() => resolve({ status: "timeout" }), 25)),
    ])

    expect(resolved).toEqual({ status: "resolved", value: driver })
    expect(await driver).toBe(driver)
    expect(mountedDrivers.cloudflare).toBeUndefined()
  })

  it("falls back through unstorage when the resolved driver lacks getItems", async () => {
    cloudflareDriver = createDriverWithoutOptionalMethods()

    const { createLazyKVRuntimeDriver } = await import("../src/runtime/driver.ts")
    const lazyDriver = createLazyKVRuntimeDriver({
      store: {
        binding: "KV",
        driver: "cloudflare-kv-binding",
      },
    })
    const lazyStorage = createStorage({ driver: lazyDriver })

    await lazyStorage.setItem("one", "first")
    await lazyStorage.setItem("two", "second")

    await expect(lazyStorage.getItems(["one", "two"])).resolves.toEqual([
      { key: "one", value: "first" },
      { key: "two", value: "second" },
    ])
  })

  it("leaves unsupported optional methods undefined on the lazy proxy", async () => {
    cloudflareDriver = createDriverWithoutOptionalMethods()

    const { createLazyKVRuntimeDriver } = await import("../src/runtime/driver.ts")
    // SAFETY: The test exercises optional Driver methods through their standard unstorage types.
    const driver = createLazyKVRuntimeDriver({
      store: {
        binding: "KV",
        driver: "cloudflare-kv-binding",
      },
    }) as Driver & Record<string, unknown>

    await driver.getItem("missing")

    expect(driver.getItemRaw).toBeUndefined()
    expect(driver.getItems).toBeUndefined()
    expect(driver.getMeta).toBeUndefined()
    expect(driver.setItemRaw).toBeUndefined()
    expect(driver.setItems).toBeUndefined()
    expect(driver.removeItems).toBeUndefined()
    expect(driver.watch).toBeUndefined()
  })

  it("exposes optional methods supported by the configured driver", async () => {
    const metadata = {
      mtime: new Date("2026-01-01T00:00:00.000Z"),
      size: 5,
    }
    // SAFETY: The fixture extends a complete minimal Driver with the optional methods under test.
    fsLiteDriver = {
      ...createDriverWithoutOptionalMethods(),
      getItemRaw: vi.fn(async () => Buffer.from("hello")),
      getMeta: vi.fn(async () => metadata),
      setItemRaw: vi.fn(async () => {}),
    } as Driver

    const { createLazyKVRuntimeDriver } = await import("../src/runtime/driver.ts")
    // SAFETY: The test inspects optional Driver properties that are intentionally outside the lazy driver's declared contract.
    const driver = createLazyKVRuntimeDriver({
      store: {
        base: ".vitehub/data/kv",
        driver: "fs-lite",
      },
    }) as Driver & Record<string, unknown>

    expect(driver.getItemRaw).toEqual(expect.any(Function))
    expect(driver.getMeta).toEqual(expect.any(Function))
    expect(driver.setItemRaw).toEqual(expect.any(Function))
    expect(driver.getItems).toBeUndefined()
    expect(driver.watch).toBeUndefined()

    await expect(driver.getItemRaw?.("greeting", {})).resolves.toEqual(Buffer.from("hello"))
    await expect(driver.getMeta?.("greeting", {})).resolves.toBe(metadata)
    await expect(driver.setItemRaw?.("greeting", Buffer.from("hello"), {})).resolves.toBeUndefined()
  })

  it("loads Deno KV through the lazy KV Store driver", async () => {
    const { openKv } = createDenoOpenKvMock()
    // SAFETY: This test provides the only Deno API used by the runtime adapter.
    ;(globalThis as typeof globalThis & { Deno?: unknown }).Deno = { openKv }

    const { createLazyKVRuntimeDriver } = await import("../src/runtime/driver.ts")
    const lazyStorage = createStorage({
      driver: createLazyKVRuntimeDriver({
        store: {
          driver: "deno-kv",
        },
      }),
    })

    await lazyStorage.setItem("lazy:one", "ok")

    expect(await lazyStorage.getItem("lazy:one")).toBe("ok")
    expect(openKv).toHaveBeenCalledWith(undefined)
  })

  it("maps the KV Store surface onto native Deno KV without exposing queue or watch handles", async () => {
    const { close, data, openKv } = createDenoOpenKvMock()
    // SAFETY: This test provides the only Deno API used by the runtime adapter.
    ;(globalThis as typeof globalThis & { Deno?: unknown }).Deno = { openKv }

    const { default: createDenoKVDriver } = await import("../src/runtime/deno-kv.ts")
    // SAFETY: The adapter implements Driver and the record intersection permits checks for deliberately omitted Deno APIs.
    const driver = createDenoKVDriver({ driver: "deno-kv", path: ":memory:" }) as Driver & Record<string, unknown>
    const storage = createStorage({ driver })

    await storage.setItem("users:42:profile", { name: "Ada" })
    await storage.setItem("users:42:prefs", { theme: "system" })
    await storage.setItem("users:7:profile", { name: "Grace" })
    data.set("nullable", null)

    expect(await storage.getItem("users:42:profile")).toEqual({ name: "Ada" })
    expect(await storage.hasItem("users:42:prefs")).toBe(true)
    expect(await driver.getItem("nullable")).toBeNull()
    expect(await driver.hasItem?.("nullable", {})).toBe(true)
    expect(await storage.getKeys("users:42:")).toEqual(["users:42:prefs", "users:42:profile"])
    expect(driver.enqueue).toBeUndefined()
    expect(driver.listenQueue).toBeUndefined()
    expect(driver.watch).toBeUndefined()

    await driver.clear?.("users:42:", {})

    expect(await storage.hasItem("users:42:profile")).toBe(false)
    expect(await storage.hasItem("users:7:profile")).toBe(true)

    await driver.dispose?.()
    expect(openKv).toHaveBeenCalledWith(":memory:")
    expect(close).toHaveBeenCalledOnce()
  })

  it("bounds and resumes fs-lite listing in filesystem traversal order", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-kv-list-"))
    try {
      await mkdir(join(root, "a"))
      await writeFile(join(root, "a", "x"), "x")
      await writeFile(join(root, "a0"), "a0")
      const { default: createFsLiteKVDriver } = await import("../src/runtime/fs-lite.ts")
      const driver = createFsLiteKVDriver({ base: root, driver: "fs-lite" })

      const first = await driver.listKeys({ limit: 1, prefix: "missing" })
      const second = await driver.listKeys({ cursor: first.cursor, limit: 1, prefix: "" })

      expect(first).toMatchObject({ keys: [], cursor: expect.any(String) })
      expect(second.keys).toEqual(["a:x"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("stops reading a flat fs-lite directory when the page is full", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-kv-flat-"))
    try {
      await Promise.all(Array.from({ length: 500 }, (_, index) => writeFile(join(root, `key-${index}`), "value")))
      const { default: createFsLiteKVDriver } = await import("../src/runtime/fs-lite.ts")
      const driver = createFsLiteKVDriver({ base: root, driver: "fs-lite" })

      await expect(driver.listKeys({ limit: 2 })).resolves.toMatchObject({
        keys: [expect.any(String), expect.any(String)],
        cursor: expect.any(String),
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("counts fs-lite directories toward bounded traversal work", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-kv-directories-"))
    try {
      let directory = root
      for (let index = 0; index < 10; index += 1) {
        directory = join(directory, `level-${index}`)
        await mkdir(directory)
      }
      await writeFile(join(directory, "key"), "value")
      const { default: createFsLiteKVDriver } = await import("../src/runtime/fs-lite.ts")
      const driver = createFsLiteKVDriver({ base: root, driver: "fs-lite" })

      const first = await driver.listKeys({ limit: 2 })

      expect(first).toEqual({ keys: [], cursor: expect.any(String) })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("releases the oldest abandoned fs-lite listing when continuation capacity is full", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-kv-continuations-"))
    try {
      await writeFile(join(root, "one"), "one")
      await writeFile(join(root, "two"), "two")
      const { default: createFsLiteKVDriver } = await import("../src/runtime/fs-lite.ts")
      const driver = createFsLiteKVDriver({ base: root, driver: "fs-lite" })
      const cursors: string[] = []
      for (let index = 0; index < 33; index += 1) {
        const page = await driver.listKeys({ limit: 1 })
        if (page.cursor) cursors.push(page.cursor)
      }

      await expect(driver.listKeys({ cursor: cursors[0], limit: 1 })).rejects.toThrow("Invalid or expired")
      await expect(driver.listKeys({ cursor: cursors.at(-1), limit: 1 })).resolves.toMatchObject({ keys: [expect.any(String)] })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("treats a missing fs-lite directory as an empty store", async () => {
    const root = join(tmpdir(), `vitehub-kv-missing-${crypto.randomUUID()}`)
    const { default: createFsLiteKVDriver } = await import("../src/runtime/fs-lite.ts")
    const driver = createFsLiteKVDriver({ base: root, driver: "fs-lite" })

    await expect(driver.listKeys({ limit: 10 })).resolves.toEqual({ keys: [] })
  })

  it("resumes fs-lite listing across canonically equivalent Unicode names", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-kv-unicode-"))
    try {
      await writeFile(join(root, "e\u0301"), "decomposed")
      await writeFile(join(root, "é"), "composed")
      const { default: createFsLiteKVDriver } = await import("../src/runtime/fs-lite.ts")
      const driver = createFsLiteKVDriver({ base: root, driver: "fs-lite" })

      const first = await driver.listKeys({ limit: 1 })
      const second = await driver.listKeys({ cursor: first.cursor, limit: 1 })

      expect([...first.keys, ...second.keys]).toHaveLength(2)
      expect([...first.keys, ...second.keys]).toEqual(expect.arrayContaining(["e\u0301", "é"]))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("resumes fs-lite listing after the cursor file is deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-kv-deleted-cursor-"))
    try {
      await writeFile(join(root, "a"), "a")
      await writeFile(join(root, "b"), "b")
      await writeFile(join(root, "c"), "c")
      const { default: createFsLiteKVDriver } = await import("../src/runtime/fs-lite.ts")
      const driver = createFsLiteKVDriver({ base: root, driver: "fs-lite" })

      const first = await driver.listKeys({ limit: 1 })
      const remaining = ["a", "b", "c"].filter(key => key !== first.keys[0])
      await rm(join(root, first.keys[0]!), { force: true })
      const second = await driver.listKeys({ cursor: first.cursor, limit: 2 })
      const third = second.cursor
        ? await driver.listKeys({ cursor: second.cursor, limit: 2 })
        : { keys: [] }

      expect([...second.keys, ...third.keys]).toEqual(expect.arrayContaining(remaining))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("uses one bounded Upstash scan with a literal prefix", async () => {
    upstashScan = vi.fn(async () => ["7", ["user:*literal"]])
    const { default: createUpstashKVDriver } = await import("../src/runtime/upstash-driver.ts")
    const driver = createUpstashKVDriver({ driver: "upstash", token: "token", url: "https://example.com" })

    await expect(driver.listKeys({ limit: 2, prefix: "user:*?[\\" })).resolves.toMatchObject({
      keys: ["user:*literal"],
      cursor: expect.any(String),
    })
    expect(upstashScan).toHaveBeenCalledOnce()
    expect(upstashScan).toHaveBeenCalledWith("0", { count: 2, match: "user:\\*\\?\\[\\\\*" })
  })

  it("caps oversized Upstash scan replies without dropping overflow", async () => {
    upstashScan = vi.fn(async () => ["0", ["one", "two", "three"]])
    const { default: createUpstashKVDriver } = await import("../src/runtime/upstash-driver.ts")
    const driver = createUpstashKVDriver({ driver: "upstash", token: "token", url: "https://example.com" })

    const first = await driver.listKeys({ limit: 2 })
    const second = await driver.listKeys({ cursor: first.cursor, limit: 2 })

    expect(first).toMatchObject({ keys: ["one", "two"], cursor: expect.any(String) })
    expect(second).toEqual({ keys: ["three"] })
    expect(first.cursor).not.toContain("three")
    expect(upstashScan).toHaveBeenCalledOnce()
  })

  it("keeps ordinary Upstash scan cursors portable across driver instances", async () => {
    upstashScan = vi.fn()
      .mockResolvedValueOnce([7, ["one", "one"]])
      .mockResolvedValueOnce([0, ["one", "two"]])
    const { default: createUpstashKVDriver } = await import("../src/runtime/upstash-driver.ts")
    const firstDriver = createUpstashKVDriver({ driver: "upstash", token: "token", url: "https://example.com" })

    const first = await firstDriver.listKeys({ limit: 2 })
    const secondDriver = createUpstashKVDriver({ driver: "upstash", token: "token", url: "https://example.com" })
    const second = await secondDriver.listKeys({ cursor: first.cursor, limit: 2 })

    expect(first).toMatchObject({ keys: ["one"], cursor: expect.any(String) })
    expect(second).toEqual({ keys: ["one", "two"] })
    expect(upstashScan).toHaveBeenNthCalledWith(2, "7", { count: 2, match: "*" })
  })

  it("does not replay an oversized Upstash scan to resume overflow", async () => {
    upstashScan = vi.fn()
      .mockResolvedValueOnce(["7", ["one", "two", "three"]])
      .mockResolvedValueOnce(["0", ["changed"]])
    const { default: createUpstashKVDriver } = await import("../src/runtime/upstash-driver.ts")
    const driver = createUpstashKVDriver({ driver: "upstash", token: "token", url: "https://example.com" })

    const first = await driver.listKeys({ limit: 2 })
    await expect(driver.listKeys({ cursor: first.cursor, limit: 2 })).resolves.toEqual({
      keys: ["three"],
      cursor: expect.any(String),
    })
    expect(upstashScan).toHaveBeenCalledOnce()
  })

  it("rejects Upstash overflow that exceeds the retained byte budget", async () => {
    upstashScan = vi.fn(async () => ["0", ["page", "x".repeat(1024 * 1024 + 1)]])
    const { default: createUpstashKVDriver } = await import("../src/runtime/upstash-driver.ts")
    const driver = createUpstashKVDriver({ driver: "upstash", token: "token", url: "https://example.com" })

    await expect(driver.listKeys({ limit: 1 })).rejects.toThrow("continuation size limit")
  })

  it("marks expired Upstash continuations separately from malformed cursors", async () => {
    upstashScan = vi.fn(async () => ["0", ["one", "two"]])
    const { default: createUpstashKVDriver } = await import("../src/runtime/upstash-driver.ts")
    const driver = createUpstashKVDriver({ driver: "upstash", token: "token", url: "https://example.com" })
    const first = await driver.listKeys({ limit: 1 })
    await driver.listKeys({ cursor: first.cursor, limit: 1 })

    await expect(driver.listKeys({ cursor: first.cursor, limit: 1 })).rejects.toMatchObject({
      code: "KV_CURSOR_EXPIRED",
    })
    await expect(driver.listKeys({ cursor: "malformed", limit: 1 })).rejects.not.toMatchObject({
      code: "KV_CURSOR_EXPIRED",
    })
  })

  it("passes a bounded page size to Deno KV for selective prefixes", async () => {
    const list = vi.fn((_selector: { prefix: [] }, _options: { cursor?: string; limit?: number } = {}) => {
      const iterator = (async function* () {
        yield { key: ["other"], value: null }
      })()
      return Object.assign(iterator, { cursor: "deno-next" })
    })
    // SAFETY: This test provides the only Deno API used by the runtime adapter.
    ;(globalThis as typeof globalThis & { Deno?: unknown }).Deno = {
      openKv: async () => ({
        delete: vi.fn(),
        get: vi.fn(),
        list,
        set: vi.fn(),
      }),
    }
    const { default: createDenoKVDriver } = await import("../src/runtime/deno-kv.ts")
    const driver = createDenoKVDriver()

    await expect(driver.listKeys({ cursor: "deno-before", limit: 3, prefix: "missing" })).resolves.toEqual({
      keys: [],
      cursor: "deno-next",
    })
    expect(list).toHaveBeenCalledWith({ prefix: [] }, { cursor: "deno-before", limit: 3 })
  })

  it("does not read a Deno KV cursor from an empty terminal page", async () => {
    const iterator = (async function* () {})()
    Object.defineProperty(iterator, "cursor", {
      get: () => {
        throw new Error("Cursor is unavailable before an entry is yielded.")
      },
    })
    // SAFETY: This test provides the only Deno API used by the runtime adapter.
    ;(globalThis as typeof globalThis & { Deno?: unknown }).Deno = {
      openKv: async () => ({
        delete: vi.fn(),
        get: vi.fn(),
        list: () => iterator,
        set: vi.fn(),
      }),
    }
    const { default: createDenoKVDriver } = await import("../src/runtime/deno-kv.ts")
    const driver = createDenoKVDriver()

    await expect(driver.listKeys({ cursor: "deno-final", limit: 3 })).resolves.toEqual({ keys: [] })
  })
})
