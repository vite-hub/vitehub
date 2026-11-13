import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { check } from "proper-lockfile"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import createFsLiteKVDriver from "../src/runtime/fs-lite.ts"
import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"

const reads = vi.hoisted(() => ({ pause: undefined as undefined | (() => Promise<void>) }))
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>()
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).includes("/expires/")) await reads.pause?.()
    return fs.readFile(...args)
  } }
})

let base: string
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), "vitehub-kv-ttl-")) })
afterEach(async () => {
  reads.pause = undefined
  vi.useRealTimers()
  await rm(base, { force: true, recursive: true })
})

function at(ms: number) {
  vi.useFakeTimers({ now: ms, toFake: ["Date"] })
}

it("expires a key that set() wrote with a ttl", async () => {
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  at(1_000_000)
  await storage.setItem("session", { user: "ada" }, { ttl: 60 })
  await storage.setItem("kept", 1)

  vi.setSystemTime(1_059_000)
  expect(await storage.getItem("session")).toEqual({ user: "ada" })
  expect(await storage.hasItem("session")).toBe(true)

  vi.setSystemTime(1_060_000)
  expect(await storage.getItem("session")).toBeNull()
  expect(await storage.hasItem("session")).toBe(false)
  expect(await storage.getKeys()).toEqual(["kept"])
  expect(await storage.listKeys({ limit: 10 })).toEqual({ keys: ["kept"] })
  expect(await storage.getItem("kept")).toBe(1)
  await storage.dispose()
})

it("removes the expiry when set() writes again without a ttl", async () => {
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  at(1_000_000)
  await storage.setItem("session", "first", { ttl: 1 })
  await storage.setItem("session", "second")

  vi.setSystemTime(2_000_000)
  expect(await storage.getItem("session")).toBe("second")
  await storage.dispose()
})

it("lets setIfAbsent() claim an expired key and expires its own claim", async () => {
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  at(1_000_000)
  expect(await storage.setIfAbsentItem!("lock", "a", 30)).toBe(true)
  expect(await storage.setIfAbsentItem!("lock", "b", 30)).toBe(false)

  vi.setSystemTime(1_030_000)
  expect(await storage.setIfAbsentItem!("lock", "c", 30)).toBe(true)
  expect(await storage.getItem("lock")).toBe("c")

  vi.setSystemTime(1_060_000)
  expect(await storage.hasItem("lock")).toBe(false)
  await storage.dispose()
})

it("lets exactly one of many concurrent calls claim an expired key", async () => {
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  at(1_000_000)
  await storage.setItem("lock", "old", { ttl: 1 })
  vi.setSystemTime(1_001_000)

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
  at(Date.now() + 3_600_000)
  expect(await storage.getItem("b")).toBe(2)
  await storage.dispose()
})

it.each(["getItem", "getItemRaw"] as const)("keeps %s and expiry in one locked snapshot", async (method) => {
  const storage = await createFsLiteKVDriver({ base, driver: "fs-lite" })
  at(1_000_000)
  await storage.setItem!("session", "expired-old", { ttl: 1 })
  vi.setSystemTime(1_002_000)
  let paused!: () => void
  let resume!: () => void
  const entered = new Promise<void>(resolve => { paused = resolve })
  const released = new Promise<void>(resolve => { resume = resolve })
  reads.pause = async () => { paused(); await released }
  const reading = storage[method]!("session", {})
  await entered
  const layout = (await readdir(base)).find(name => name.startsWith(".unstorage-tmp-vitehub-migration-"))!
  const lockPath = join(base, layout, "locks", createHash("sha256").update("session").digest("hex"))
  const locked = await check(lockPath, { realpath: false })
  const replacement = storage.setItem!("session", "replacement", {})
  reads.pause = undefined
  resume()
  const value = await reading
  await replacement
  expect(locked).toBe(true)
  expect(value).toBeNull()
  expect(await storage.getItem("session", {})).toBe("replacement")
  await storage.dispose?.()
})

it("preserves expiry outside a cleared prefix", async () => {
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  at(1_000_000)
  await storage.setItem("removed:a", 1, { ttl: 1 })
  await storage.setItem("kept:a", 2, { ttl: 1 })
  await storage.clear("removed:")
  vi.setSystemTime(1_002_000)
  expect(await storage.getItem("kept:a")).toBeNull()
  await storage.dispose()
})
