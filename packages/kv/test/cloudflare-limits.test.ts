import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import memoryDriver from "unstorage/drivers/memory"

const puts: Array<{ key: string, options: unknown }> = []

vi.mock("unstorage/drivers/cloudflare-kv-binding", () => ({
  default: vi.fn(() => {
    const driver = memoryDriver()
    return {
      ...driver,
      async setItem(key: string, value: string, options: unknown) {
        puts.push({ key, options })
        await driver.setItem!(key, value, {})
      },
    }
  }),
}))

vi.mock("unstorage/drivers/fs-lite", () => ({ default: vi.fn(() => memoryDriver()) }))

const mib = 1024 * 1024

describe("Cloudflare KV limits", () => {
  beforeEach(() => {
    vi.resetModules()
    puts.length = 0
  })

  afterEach(() => {
    delete process.env.VITEHUB_HOSTING
  })

  async function cloudflareKV() {
    process.env.VITEHUB_HOSTING = "cloudflare"
    return (await import("../src/runtime/storage.ts")).kv
  }

  it("returns KV_KEY_TOO_LONG for a key above 512 UTF-8 bytes, before the provider call", async () => {
    const kv = await cloudflareKV()

    const [setError] = await kv.set("k".repeat(513), "value")
    expect(setError).toMatchObject({
      code: "KV_KEY_TOO_LONG",
      docs: "https://vitehub.dev/docs/kv/limits-and-errors#kv_key_too_long",
      why: "The key is 513 bytes in UTF-8. Cloudflare KV accepts keys of at most 512 bytes.",
    })
    expect(puts).toEqual([])

    // Two bytes per character in UTF-8, so 257 characters are 514 bytes.
    const [multibyteError] = await kv.set("é".repeat(257), "value")
    expect(multibyteError?.code).toBe("KV_KEY_TOO_LONG")

    for (const [error] of [await kv.get("k".repeat(513)), await kv.has("k".repeat(513)), await kv.del("k".repeat(513))]) {
      expect(error?.code).toBe("KV_KEY_TOO_LONG")
    }

    const [error] = await kv.set("k".repeat(512), "value")
    expect(error).toBeUndefined()
    expect(puts).toHaveLength(1)
  })

  it("returns KV_VALUE_TOO_LARGE for a value above 25 MiB", async () => {
    const kv = await cloudflareKV()

    const [error] = await kv.set("large", "v".repeat(25 * mib + 1))
    expect(error).toMatchObject({ code: "KV_VALUE_TOO_LARGE", why: "The value is 26214401 bytes. Cloudflare KV accepts values of at most 26214400 bytes (25 MiB)." })
    expect(puts).toEqual([])

    const [multibyteError] = await kv.set("large", "é".repeat(12.5 * mib + 1))
    expect(multibyteError?.code).toBe("KV_VALUE_TOO_LARGE")

    const [fits] = await kv.set("large", "v".repeat(25 * mib))
    expect(fits).toBeUndefined()
  })

  it("returns KV_METADATA_TOO_LARGE for metadata above 1024 bytes as JSON", async () => {
    const kv = await cloudflareKV()

    const [error] = await kv.set("meta", "value", { metadata: "x".repeat(1023) })
    expect(error).toMatchObject({ code: "KV_METADATA_TOO_LARGE", why: "The metadata is 1025 bytes as JSON. Cloudflare KV accepts metadata of at most 1024 bytes." })
    expect(puts).toEqual([])

    const [fits] = await kv.set("meta", "value", { metadata: "x".repeat(1022) })
    expect(fits).toBeUndefined()
  })

  it("returns KV_TTL_TOO_SHORT for an expirationTtl below 60 seconds", async () => {
    const kv = await cloudflareKV()

    const [error] = await kv.set("ttl", "value", { expirationTtl: 59 })
    expect(error).toMatchObject({ code: "KV_TTL_TOO_SHORT", why: "`expirationTtl` is 59 seconds. Cloudflare KV needs at least 60 seconds." })
    expect(puts).toEqual([])

    // The `ttl` option is raised to 60 seconds before the provider call, as before.
    expect((await kv.set("ttl", "value", { ttl: 30 }))[0]).toBeUndefined()
    expect((await kv.set("ttl", "value", { expirationTtl: 60 }))[0]).toBeUndefined()
  })

  it("keeps local stores without a host unchanged", async () => {
    process.env.VITEHUB_HOSTING = "local"
    const { kv } = await import("../src/runtime/storage.ts")

    const [error] = await kv.set("k".repeat(513), "value", { expirationTtl: 1 })
    expect(error).toBeUndefined()
  })
})
