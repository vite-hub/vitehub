import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import memoryDriver from "unstorage/drivers/memory"

const deletes: string[] = []
const puts: Array<{ key: string, options: unknown }> = []

vi.mock("unstorage/drivers/cloudflare-kv-binding", () => ({
  default: vi.fn(() => {
    const driver = memoryDriver()
    return {
      ...driver,
      async removeItem(key: string) {
        deletes.push(key)
        await driver.removeItem!(key, {})
      },
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
    deletes.length = 0
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

  it.each(["cloudflare", "local"])("preflights mixed writes and deletions on %s stores", async (host) => {
    process.env.VITEHUB_HOST = host
    const { createKVStorage } = await import("../src/runtime/create-storage.ts")
    const { default: createDriver } = await import("../src/runtime/cloudflare-kv.ts")
    const { default: createLocalDriver } = await import("../src/runtime/cloudflare-kv-local.ts")
    const driver = host === "cloudflare" ? createDriver({ binding: "KV" }) : createLocalDriver({ driver: "cloudflare-kv-binding", binding: "KV", localBase: "/tmp/kv-batch-preflight" })
    const storage = createKVStorage(driver)
    await storage.setItem("keep", "original")
    puts.length = 0
    for (const entries of [
      [{ key: "keep", value: undefined }, { key: "k".repeat(513), value: "bad" }],
      [{ key: "write", value: "good" }, { key: "k".repeat(513), value: undefined }],
      [{ key: "k".repeat(513), value: undefined }],
    ]) {
      await expect(storage.setMany(entries)).rejects.toMatchObject({ code: "KV_KEY_TOO_LONG" })
      expect(puts).toEqual([])
      expect(deletes).toEqual([])
      expect(await storage.getItem("keep")).toBe("original")
      expect(await storage.getItem("write")).toBeNull()
    }
    await storage.dispose()
  })

  it("returns the limit codes from getMany() and setMany() before any provider call", async () => {
    const kv = await cloudflareKV()

    const [getError] = await kv.getMany(["a", "k".repeat(513)])
    expect(getError?.code).toBe("KV_KEY_TOO_LONG")
    // SAFETY: A JavaScript caller can pass options that the type rejects.
    const [setError] = await kv.setMany([{ key: "a", value: "1" }, { key: "b", value: "1" }], { expirationTtl: 30 } as { ttl?: number })
    expect(setError?.code).toBe("KV_INVALID_OPTION")
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

  it("raises a ttl below 60 seconds to 60 before the provider call", async () => {
    const kv = await cloudflareKV()

    expect((await kv.set("short", "value", { ttl: 30 }))[0]).toBeUndefined()
    expect((await kv.set("long", "value", { ttl: 300 }))[0]).toBeUndefined()
    expect(puts).toEqual([{ key: "short", options: { ttl: 60 } }, { key: "long", options: { ttl: 300 } }])
  })

  it.each([{ expirationTtl: 60 }, { expiration: 1_800_000_000 }, { metadata: "x" }])("returns KV_INVALID_OPTION for the Cloudflare option %o", async (options) => {
    const kv = await cloudflareKV()

    // SAFETY: A JavaScript caller can pass options that the type rejects.
    const [error] = await kv.set("key", "value", options as { ttl?: number })
    expect(error).toMatchObject({ code: "KV_INVALID_OPTION", docs: "https://vitehub.dev/docs/kv/diagnostics/kv_invalid_option" })
    expect(puts).toEqual([])
  })

  it("keeps local stores without a host unchanged", async () => {
    process.env.VITEHUB_HOST = "local"
    const { kv } = await import("../src/runtime/storage.ts")

    const [error] = await kv.set("k".repeat(513), "value", { ttl: 1 })
    expect(error).toBeUndefined()
  })
})
