import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createStorage, prefixStorage } from "unstorage"
import memoryDriver from "unstorage/drivers/memory"

const runtimeState = {
  config: {
    kv: false,
  } as Record<string, unknown>,
}

const mountedDrivers: {
  fsLite?: Record<string, unknown>
  upstash?: Record<string, unknown>
} = {}

let storage = createStorage({ driver: memoryDriver() })

function resetStorage() {
  storage = createStorage({ driver: memoryDriver() })
  delete mountedDrivers.fsLite
  delete mountedDrivers.upstash
}

function createInspectableDriver(name: "fsLite" | "upstash") {
  return (options: Record<string, unknown> = {}) => {
    mountedDrivers[name] = options
    return memoryDriver()
  }
}

vi.mock("nitro/runtime", () => ({
  defineNitroPlugin: (plugin: unknown) => plugin,
  useRuntimeConfig: () => runtimeState.config,
  useStorage: (base = "") => base ? prefixStorage(storage, base) : storage,
}))

vi.mock("unstorage/drivers/fs-lite", () => ({
  default: vi.fn(createInspectableDriver("fsLite")),
}))

vi.mock("unstorage/drivers/upstash", () => ({
  default: vi.fn(createInspectableDriver("upstash")),
}))

vi.mock("unstorage/drivers/cloudflare-kv-binding", () => ({
  default: vi.fn(() => memoryDriver()),
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

    const plugin = (await import("../src/runtime/nitro-plugin.ts")).default as () => Promise<void>
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

    const plugin = (await import("../src/runtime/nitro-plugin.ts")).default as () => Promise<void>
    await plugin()

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

    const plugin = (await import("../src/runtime/nitro-plugin.ts")).default as () => Promise<void>
    await plugin()

    expect(mountedDrivers.upstash).toMatchObject({
      driver: "upstash",
      token: "legacy-upstash-token",
      url: "https://legacy-upstash.example.com",
    })
  })

  it("fails clearly when masked Upstash values have no runtime env vars", async () => {
    runtimeState.config = {
      kv: {
        store: {
          driver: "upstash",
          token: "********",
          url: "********",
        },
      },
    }

    const plugin = (await import("../src/runtime/nitro-plugin.ts")).default as () => Promise<void>

    await expect(plugin()).rejects.toThrow("Missing runtime environment variable `KV_REST_API_URL` for Upstash KV.")
  })
})
