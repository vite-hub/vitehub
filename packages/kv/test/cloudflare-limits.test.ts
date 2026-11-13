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
    vi.restoreAllMocks()
    delete process.env.VITEHUB_HOST
  })

  async function cloudflareKV() {
    process.env.VITEHUB_HOST = "cloudflare"
    return (await import("../src/runtime/storage.ts")).kv
  }

  it("returns KV_KEY_TOO_LONG for a key above 512 UTF-8 bytes, before the provider call", async () => {
    const kv = await cloudflareKV()

    const [setError] = await kv.set("k".repeat(513), "value")
    expect(setError).toMatchObject({
      code: "KV_KEY_TOO_LONG",
      docs: "https://vitehub.dev/docs/kv/diagnostics/kv_key_too_long",
      why: "The key is 513 bytes in UTF-8. Cloudflare KV accepts keys of at most 512 bytes.",
    })
    expect(puts).toEqual([])

    // Two bytes per character in UTF-8, so 257 characters are 514 bytes.
    const [multibyteError] = await kv.set("é".repeat(257), "value")
    expect(multibyteError?.code).toBe("KV_KEY_TOO_LONG")

    for (const [error] of [await kv.get("k".repeat(513)), await kv.has("k".repeat(513)), await kv.delete("k".repeat(513))]) {
      expect(error?.code).toBe("KV_KEY_TOO_LONG")
    }

    const [error] = await kv.set("k".repeat(512), "value")
    expect(error).toBeUndefined()
    expect(puts).toHaveLength(1)
  })

  it("returns the limit codes from getMany() and setMany() before any provider call", async () => {
    const kv = await cloudflareKV()

    const [getError] = await kv.getMany(["a", "k".repeat(513)])
    expect(getError?.code).toBe("KV_KEY_TOO_LONG")
    const [setError] = await kv.setMany([{ key: "a", value: "1" }, { key: "b", value: "1" }], { expirationTtl: 30 })
    expect(setError?.code).toBe("KV_TTL_TOO_SHORT")
    const [keyError] = await kv.setMany([{ key: "a", value: "1" }, { key: "k".repeat(513), value: "1" }])
    expect(keyError?.code).toBe("KV_KEY_TOO_LONG")
    expect(puts).toEqual([])

    // SAFETY: JavaScript callers can pass a value that the types reject.
    await expect(kv.getMany("a" as unknown as string[])).rejects.toMatchObject({ code: "KV_INVALID_BATCH" })
    // SAFETY: As above.
    await expect(kv.setMany({ key: "a", value: 1 } as unknown as [])).rejects.toMatchObject({ code: "KV_INVALID_BATCH" })

    const [error] = await kv.setMany([{ key: "a", value: "1" }, { key: "b", value: "2" }])
    expect(error).toBeUndefined()
    expect(puts.map(put => put.key).sort()).toEqual(["a", "b"])
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

  it.each([-1, 0, 59])("returns KV_TTL_TOO_SHORT for an expiration %i seconds from now before the provider call", async (seconds) => {
    const now = 1_800_000_000
    vi.spyOn(Date, "now").mockReturnValue(now * 1000 + 500)
    const kv = await cloudflareKV()

    const [error] = await kv.set("expiration", "value", { expiration: now + seconds })
    expect(error).toMatchObject({
      code: "KV_TTL_TOO_SHORT",
      why: `\`expiration\` is ${seconds} seconds from now. Cloudflare KV needs at least 60 seconds.`,
    })
    expect(puts).toEqual([])
  })

  it.each([60, 61])("passes an expiration %i seconds from now unchanged to the provider", async (seconds) => {
    const now = 1_800_000_000
    vi.spyOn(Date, "now").mockReturnValue(now * 1000 + 500)
    const kv = await cloudflareKV()
    const options = { expiration: now + seconds }

    expect((await kv.set("expiration", "value", options))[0]).toBeUndefined()
    expect(puts).toEqual([{ key: "expiration", options }])
  })

  it("keeps relative expiration precedence over a short absolute expiration", async () => {
    const now = 1_800_000_000
    vi.spyOn(Date, "now").mockReturnValue(now * 1000)
    const kv = await cloudflareKV()

    for (const relative of [{ expirationTtl: 60 }, { ttl: 30 }]) {
      const options = { expiration: now + 1, ...relative }
      expect((await kv.set("expiration", "value", options))[0]).toBeUndefined()
      expect(puts.at(-1)).toEqual({ key: "expiration", options })
    }
    expect(puts).toHaveLength(2)
  })

  it("keeps local stores without a host unchanged", async () => {
    process.env.VITEHUB_HOST = "local"
    const { kv } = await import("../src/runtime/storage.ts")

    const [error] = await kv.set("k".repeat(513), "value", { expirationTtl: 1 })
    expect(error).toBeUndefined()
  })
})
