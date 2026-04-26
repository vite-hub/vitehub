import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createStorage, prefixStorage } from "unstorage"
import type { Driver } from "unstorage"
import memoryDriver from "unstorage/drivers/memory"

const runtimeState = {
  config: {
    kv: false,
  } as Record<string, unknown>,
}

const mountedDrivers: {
  cloudflare?: Record<string, unknown>
  fsLite?: Record<string, unknown>
  upstash?: Record<string, unknown>
} = {}

let storage = createStorage({ driver: memoryDriver() })
let cloudflareDriver: Driver | undefined

const mockedUseStorage = (base = "") => (base ? prefixStorage(storage, base) : storage)

function resetStorage() {
  storage = createStorage({ driver: memoryDriver() })
  cloudflareDriver = undefined
  delete mountedDrivers.cloudflare
  delete mountedDrivers.fsLite
  delete mountedDrivers.upstash
}

function createInspectableDriver(name: "fsLite" | "upstash") {
  return (options: Record<string, unknown> = {}) => {
    mountedDrivers[name] = options
    return memoryDriver()
  }
}

function createDriverWithoutOptionalMethods(): Driver {
  const data = new Map<string, unknown>()

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

vi.mock("nitro", () => ({
  definePlugin: (plugin: unknown) => plugin,
}))

vi.mock("nitro/runtime-config", () => ({
  useRuntimeConfig: () => runtimeState.config,
}))

vi.mock("nitro/storage", () => ({
  defineNitroPlugin: (plugin: unknown) => plugin,
  useStorage: mockedUseStorage,
}))

vi.mock("unstorage/drivers/fs-lite", () => ({
  default: vi.fn(createInspectableDriver("fsLite")),
}))

vi.mock("unstorage/drivers/upstash", () => ({
  default: vi.fn(createInspectableDriver("upstash")),
}))

vi.mock("unstorage/drivers/cloudflare-kv-binding", () => ({
  default: vi.fn((options: Record<string, unknown> = {}) => {
    mountedDrivers.cloudflare = options
    return cloudflareDriver || memoryDriver()
  }),
}))

describe("kv runtime", () => {
  beforeEach(async () => {
    vi.resetModules()
    resetStorage()
    runtimeState.config = {
      kv: false,
    }
  })

  afterEach(() => {
    delete process.env.KV_REST_API_URL
    delete process.env.KV_REST_API_TOKEN
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
  })

  it("mounts fs-lite storage when the local fallback is active", async () => {
    runtimeState.config = {
      kv: {
        store: {
          base: ".data/kv",
          driver: "fs-lite",
        },
      },
    }

    const plugin = (await import("../src/runtime/nitro-plugin.ts")).default as () => void | Promise<void>
    await plugin()

    const { kv } = await import("../src/runtime/storage.ts")
    await kv.set("notes/hello", "world")

    expect(await kv.get("notes/hello")).toBe("world")
    expect(mountedDrivers.fsLite).toMatchObject({
      base: ".data/kv",
      driver: "fs-lite",
    })
  })

  it("prefers runtime env vars over masked Upstash config values", async () => {
    process.env.KV_REST_API_URL = "https://upstash.example.com"
    process.env.KV_REST_API_TOKEN = "upstash-token"
    runtimeState.config = {
      kv: {
        store: {
          driver: "upstash",
          token: "************",
          url: "************",
        },
      },
    }

    const plugin = (await import("../src/runtime/nitro-plugin.ts")).default as () => void | Promise<void>
    await plugin()

    expect(mountedDrivers.upstash).toBeUndefined()

    const { kv } = await import("../src/runtime/storage.ts")
    await kv.set("notes/hello", "world")

    expect(await kv.get("notes/hello")).toBe("world")
    expect(mountedDrivers.upstash).toMatchObject({
      driver: "upstash",
      token: "upstash-token",
      url: "https://upstash.example.com",
    })
  })

  it("accepts legacy Upstash runtime env var aliases", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://legacy-upstash.example.com"
    process.env.UPSTASH_REDIS_REST_TOKEN = "legacy-upstash-token"
    runtimeState.config = {
      kv: {
        store: {
          driver: "upstash",
          token: "************",
          url: "************",
        },
      },
    }

    const plugin = (await import("../src/runtime/nitro-plugin.ts")).default as () => void | Promise<void>
    await plugin()

    expect(mountedDrivers.upstash).toBeUndefined()

    const { kv } = await import("../src/runtime/storage.ts")
    await kv.has("notes/hello")

    expect(mountedDrivers.upstash).toMatchObject({
      driver: "upstash",
      token: "legacy-upstash-token",
      url: "https://legacy-upstash.example.com",
    })
  })

  it("does not initialize Upstash during plugin startup for non-KV requests", async () => {
    runtimeState.config = {
      kv: {
        store: {
          driver: "upstash",
          token: "********",
          url: "********",
        },
      },
    }

    const plugin = (await import("../src/runtime/nitro-plugin.ts")).default as () => void | Promise<void>
    await plugin()
    expect(mountedDrivers.upstash).toBeUndefined()
  })

  it("replaces the masked kv mount during plugin startup", async () => {
    runtimeState.config = {
      kv: {
        store: {
          driver: "upstash",
          token: "********",
          url: "********",
        },
      },
    }

    const plugin = (await import("../src/runtime/nitro-plugin.ts")).default as () => void | Promise<void>
    await plugin()

    const { useStorage } = await import("nitro/storage")
    expect(useStorage().getMount("kv")?.driver).toMatchObject({
      name: "lazy:upstash",
      options: {
        driver: "upstash",
        token: "********",
        url: "********",
      },
    })
  })

  it("does not make the lazy driver thenable", async () => {
    const { createLazyKVRuntimeDriver } = await import("../src/runtime/driver.ts")
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

  it("fails clearly when masked Upstash values have no runtime env vars on first KV access", async () => {
    runtimeState.config = {
      kv: {
        store: {
          driver: "upstash",
          token: "********",
          url: "********",
        },
      },
    }

    const plugin = (await import("../src/runtime/nitro-plugin.ts")).default as () => void | Promise<void>
    await plugin()

    const { kv } = await import("../src/runtime/storage.ts")

    await expect(kv.get("notes/hello")).rejects.toThrow("Missing runtime environment variable `KV_REST_API_URL` for Upstash KV.")
  })
})
