import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import createCloudflareKVLocalDriver from "../src/runtime/cloudflare-kv-local.ts"
import createFsLiteKVDriver from "../src/runtime/fs-lite.ts"
import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"

const interruption = vi.hoisted(() => ({ remove: undefined as (() => Promise<void>) | undefined }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]).endsWith("/key-lock")) await interruption.remove?.()
      return actual.rm(...args)
    },
  }
})

let base: string
beforeEach(async () => {
  // Fake only Date, so filesystem promises still resolve.
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 13), toFake: ["Date"] })
  base = await mkdtemp(join(tmpdir(), "vitehub-kv-fs-ttl-"))
})
afterEach(async () => {
  interruption.remove = undefined
  vi.useRealTimers()
  await rm(base, { force: true, recursive: true })
})

it("expires a key after its ttl in every read", async () => {
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    await storage.setItem("otp:ada", "code-123456", { ttl: 1 })
    await storage.setItem("keep", "yes")
    vi.advanceTimersByTime(999)
    await expect(storage.getItem("otp:ada")).resolves.toBe("code-123456")
    await expect(storage.hasItem("otp:ada")).resolves.toBe(true)

    vi.advanceTimersByTime(501)
    await expect(storage.getItem("otp:ada")).resolves.toBeNull()
    await expect(storage.hasItem("otp:ada")).resolves.toBe(false)
    await expect(storage.getKeys()).resolves.toEqual(["keep"])
    await expect(storage.listKeys({ limit: 10 })).resolves.toEqual({ keys: ["keep"] })
    await expect(storage.getItem("keep")).resolves.toBe("yes")
    // Reads delete the expired file, and only keys stay in the base folder.
    expect((await readdir(base)).filter(name => name.startsWith("key-"))).toEqual(["key-keep"])
  }
  finally {
    await storage.dispose()
  }
})

it("removes the expiry when a later write sets no ttl, and replaces it when the write sets one", async () => {
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    await storage.setItem("session", "a", { ttl: 1 })
    await storage.setItem("session", "b")
    vi.advanceTimersByTime(5_000)
    await expect(storage.getItem("session")).resolves.toBe("b")

    await storage.setItem("session", "c", { ttl: 10 })
    vi.advanceTimersByTime(5_000)
    await storage.setItem("session", "d", { ttl: 1 })
    vi.advanceTimersByTime(1_001)
    await expect(storage.hasItem("session")).resolves.toBe(false)

    await storage.setItem("deleted", "x", { ttl: 1 })
    await storage.removeItem("deleted")
    await storage.setItem("deleted", "y")
    vi.advanceTimersByTime(5_000)
    await expect(storage.getItem("deleted")).resolves.toBe("y")
  }
  finally {
    await storage.dispose()
  }
})

it("lets setIfAbsent claim an expired key and expire its own claim", async () => {
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    await expect(storage.setIfAbsentItem!("lock", "first", 1)).resolves.toBe(true)
    await expect(storage.setIfAbsentItem!("lock", "second", 1)).resolves.toBe(false)
    vi.advanceTimersByTime(1_001)
    await expect(storage.setIfAbsentItem!("lock", "third")).resolves.toBe(true)
    await expect(storage.getItem("lock")).resolves.toBe("third")
    vi.advanceTimersByTime(60_000)
    await expect(storage.getItem("lock")).resolves.toBe("third")
  }
  finally {
    await storage.dispose()
  }
})

it("lets exactly one of many concurrent calls claim an expired key", async () => {
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  await storage.setItem("lock", "old", { ttl: 1 })
  vi.setSystemTime(Date.now() + 1_000)

  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => storage.setIfAbsentItem!("lock", `owner-${index}`, 30)))
  expect(results.filter(Boolean)).toHaveLength(1)
  expect(await storage.getItem("lock")).toBe(`owner-${results.indexOf(true)}`)
  await storage.dispose()
})

it("removes the expiry files with the key and with clear()", async () => {
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  await storage.setItem("a", 1, { ttl: 60 })
  await storage.removeItem("a")
  await storage.setItem("a", 2)
  expect(await storage.getItem("a")).toBe(2)

  await storage.setItem("b", 1, { ttl: 60 })
  await storage.clear()
  expect((await readdir(base)).filter(name => name.startsWith("key-"))).toEqual([])
  await storage.setItem("b", 2)
  vi.setSystemTime(Date.now() + 3_600_000)
  expect(await storage.getItem("b")).toBe(2)
  await storage.dispose()
})

it("keeps files without an expiry, as older versions wrote them", async () => {
  // The old layout stored `legacy` as a plain file. The first open migrates it.
  await writeFile(join(base, "legacy"), "\"old\"")
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000)
    await expect(storage.getItem("legacy")).resolves.toBe("old")
  }
  finally {
    await storage.dispose()
  }
})

it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "60"])("rejects ttl %s like the other drivers", async (ttl) => {
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  try {
    await expect(storage.setItem("key", "value", { ttl })).rejects.toMatchObject({ code: "KV_INVALID_TTL" })
    await expect(storage.hasItem("key")).resolves.toBe(false)
  }
  finally {
    await storage.dispose()
  }
})

it("expires keys in the Cloudflare KV fallback of vite dev", async () => {
  const driver = createCloudflareKVLocalDriver({ binding: "KV", driver: "cloudflare-kv-binding", localBase: base })
  try {
    await driver.setItem?.("ttl", "\"a\"", { ttl: 60 })
    await driver.setItem?.("relative", "\"b\"", { expirationTtl: 120 })
    await driver.setItem?.("absolute", "\"c\"", { expiration: Math.floor(Date.now() / 1000) + 180 })
    vi.advanceTimersByTime(60_001)
    await expect(driver.getKeys("", {})).resolves.toEqual(expect.arrayContaining(["relative", "absolute"]))
    await expect(driver.hasItem("ttl", {})).resolves.toBe(false)
    vi.advanceTimersByTime(60_000)
    await expect(driver.hasItem("relative", {})).resolves.toBe(false)
    await expect(driver.hasItem("absolute", {})).resolves.toBe(true)
    vi.advanceTimersByTime(60_000)
    await expect(driver.listKeys({ limit: 10 })).resolves.toEqual({ keys: [] })
  }
  finally {
    await driver.dispose?.()
  }
})

it("serializes expired cleanup with another driver's claim", async () => {
  const first = await createFsLiteKVDriver({ base, driver: "fs-lite" })
  const second = await createFsLiteKVDriver({ base, driver: "fs-lite" })
  let resume!: () => void
  let paused!: () => void
  const gate = new Promise<void>((resolve) => { resume = resolve })
  const reached = new Promise<void>((resolve) => { paused = resolve })
  try {
    await first.setIfAbsentItem!("lock", "old", 1)
    vi.advanceTimersByTime(1_001)
    interruption.remove = async () => {
      interruption.remove = undefined
      paused()
      await gate
    }
    const claimA = first.setIfAbsentItem!("lock", "owner-a")
    await reached
    const claimB = second.setIfAbsentItem!("lock", "owner-b")
    // Give B a chance to publish while A is paused immediately before deleting the old value.
    await Promise.race([claimB, new Promise(resolve => setTimeout(resolve, 100))])
    resume()
    expect(await Promise.all([claimA, claimB])).toEqual([true, false])
    await expect(first.getItem("lock", {})).resolves.toBe("owner-a")
  }
  finally {
    resume?.()
    await first.dispose?.()
    await second.dispose?.()
  }
})

it("preserves unrelated expiry when clearing a prefix", async () => {
  const driver = await createFsLiteKVDriver({ base, driver: "fs-lite" })
  try {
    await driver.setItem!("remove:a", "a", { ttl: 1 })
    await driver.setItem!("keep:b", "b", { ttl: 1 })
    await driver.clear!("remove:", {})
    vi.advanceTimersByTime(1_001)
    await expect(driver.hasItem("keep:b", {})).resolves.toBe(false)
  }
  finally { await driver.dispose?.() }
})
