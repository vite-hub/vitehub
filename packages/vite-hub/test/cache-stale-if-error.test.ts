import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { CacheOptions, StorageInterface } from "ocache"
import { createStorage, prefixStorage, type Driver, type Storage } from "unstorage"
import fsLite from "unstorage/drivers/fs-lite"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { defineCachedFunction, invalidateTag } from "../src/cache.ts"

const kvState = vi.hoisted(() => ({ root: undefined as Storage | undefined }))

function root(): Storage {
  if (!kvState.root) throw new TypeError("The test KV store is not set.")
  return kvState.root
}

// The same wiring as a Nitro build with a `cache` mount: one unstorage instance, and Nitro's `cache.driver: "kv"` adapter.
vi.mock("nitro/kv", () => ({
  useKV: (base = "") => base ? prefixStorage(root(), base) : root(),
}))

vi.mock("nitro/cache", async () => {
  const ocache = await import("ocache")
  const storage = (): StorageInterface => ({
    // SAFETY: Nitro's adapter returns what unstorage parsed. The cache checks the entry shape when it reads it.
    get: <T>(key: string) => root().getItem(key) as Promise<T | null>,
    set: (key, value, opts) => root().setItem(key, JSON.parse(JSON.stringify(value)), opts?.ttl ? { ttl: opts.ttl } : undefined),
  })
  return {
    defineCachedFunction: <T, ArgsT extends unknown[]>(fn: (...args: ArgsT) => T | Promise<T>, opts: CacheOptions<T, ArgsT> = {}) =>
      ocache.defineCachedFunction(fn, { group: "nitro/functions", storage, ...opts }),
    defineCachedHandler: ocache.defineCachedHandler,
  }
})

/** A Workers-KV-like driver: string values only, and a TTL that deletes the value. */
function fakeKV(): Driver {
  const data = new Map<string, { value: string, until?: number }>()
  const read = (key: string) => {
    const item = data.get(key)
    if (item?.until !== undefined && Date.now() >= item.until) data.delete(key)
    return data.get(key)?.value ?? null
  }
  return {
    name: "fake-kv",
    hasItem: key => read(key) !== null,
    getItem: read,
    setItem: (key, value, opts: { ttl?: number }) => void data.set(key, { value, until: opts?.ttl ? Date.now() + opts.ttl * 1000 : undefined }),
    removeItem: key => void data.delete(key),
    getKeys: () => [...data.keys()],
    clear: () => data.clear(),
  }
}

const pending: Promise<unknown>[] = []
const waitUntil = (promise: Promise<unknown>) => void pending.push(promise)
/** Waits for the cache writes that ocache runs in the background. */
async function settle() {
  while (pending.length) await Promise.all(pending.splice(0))
}

function advance(seconds: number) {
  vi.setSystemTime(Date.now() + seconds * 1000)
}

/** An exchange-rate source that fails while `down` is true. */
function ratesSource() {
  const source = { calls: 0, down: false, rate: 0.9 }
  const fetchRates = async (base: string) => {
    source.calls++
    if (source.down) throw new Error("Frankfurter answered 503")
    return { base, EUR: source.rate }
  }
  return { fetchRates, source }
}

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { force: true, recursive: true })
})

describe.each([
  ["fs-lite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vitehub-cache-stale-"))
    dirs.push(dir)
    return fsLite({ base: dir })
  }],
  ["fake KV with TTL", async () => fakeKV()],
])("staleIfError on %s", (_name, driver) => {
  const onError = vi.fn()

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    kvState.root = createStorage()
    kvState.root.mount("cache", await driver())
    onError.mockReset()
  })

  afterEach(async () => {
    await settle()
    vi.useRealTimers()
  })

  it("returns the stored value when the function throws after maxAge, and runs the function again on the next call", async () => {
    const { fetchRates, source } = ratesSource()
    const getRates = defineCachedFunction(fetchRates, { getKey: base => base, maxAge: 60, onError, staleIfError: 3600, waitUntil })

    expect(await getRates("USD")).toEqual({ base: "USD", EUR: 0.9 })
    await settle()

    advance(120)
    source.down = true
    expect(await getRates("USD")).toEqual({ base: "USD", EUR: 0.9 })
    expect(await getRates("USD")).toEqual({ base: "USD", EUR: 0.9 })
    await settle()
    expect(source.calls).toBe(3)
    expect(onError).toHaveBeenCalledTimes(2)
    expect(onError.mock.calls[0]![0]).toMatchObject({ message: "Frankfurter answered 503" })

    source.down = false
    source.rate = 0.95
    expect(await getRates("USD")).toEqual({ base: "USD", EUR: 0.95 })
    await settle()
    expect(await getRates("USD")).toEqual({ base: "USD", EUR: 0.95 })
    expect(source.calls).toBe(4)
  })

  it("returns the error after staleIfError ends", async () => {
    const { fetchRates, source } = ratesSource()
    const getRates = defineCachedFunction(fetchRates, { getKey: base => base, maxAge: 60, onError, staleIfError: 600, waitUntil })

    await getRates("USD")
    await settle()
    // ocache writes a refreshed entry in another shape than a new one.
    advance(61)
    source.rate = 0.95
    expect(await getRates("USD")).toEqual({ base: "USD", EUR: 0.95 })
    await settle()

    // A failure inside the window does not move the window.
    advance(600)
    source.down = true
    expect(await getRates("USD")).toEqual({ base: "USD", EUR: 0.95 })
    await settle()

    advance(61)
    await expect(getRates("USD")).rejects.toThrow("Frankfurter answered 503")
  })

  it("returns the error when nothing is stored", async () => {
    const { fetchRates, source } = ratesSource()
    source.down = true
    const getRates = defineCachedFunction(fetchRates, { getKey: base => base, maxAge: 60, onError, staleIfError: 3600, waitUntil })

    await expect(getRates("USD")).rejects.toThrow("Frankfurter answered 503")
    expect(onError).not.toHaveBeenCalled()
  })

  it("keeps the entry in storage for maxAge plus staleIfError", async () => {
    const setItem = vi.spyOn(root(), "setItem")
    const { fetchRates } = ratesSource()
    const getRates = defineCachedFunction(fetchRates, { getKey: base => base, maxAge: 60, staleIfError: 3600, waitUntil })

    await getRates("USD")
    await settle()
    expect(setItem).toHaveBeenCalledWith(expect.stringContaining("USD"), expect.objectContaining({ value: { base: "USD", EUR: 0.9 } }), { ttl: 3660 })
  })

  it("keeps an swr entry when its background refresh throws", async () => {
    const { fetchRates, source } = ratesSource()
    const getRates = defineCachedFunction(fetchRates, { getKey: base => base, maxAge: 60, onError, staleIfError: 3600, staleMaxAge: 60, swr: true, waitUntil })

    await getRates("USD")
    await settle()

    advance(90)
    source.down = true
    expect(await getRates("USD")).toEqual({ base: "USD", EUR: 0.9 })
    await settle()

    // Past maxAge plus staleMaxAge, swr has nothing to serve, and staleIfError still has the entry.
    advance(60)
    expect(await getRates("USD")).toEqual({ base: "USD", EUR: 0.9 })
    expect(source.calls).toBe(3)
  })

  it("returns the stored value after invalidateTag() when the function throws", async () => {
    const { fetchRates, source } = ratesSource()
    const getRates = defineCachedFunction(fetchRates, { getKey: base => base, maxAge: 60, onError, staleIfError: 3600, tags: ["rates"], waitUntil })

    await getRates("USD")
    await settle()
    advance(1)
    await invalidateTag("rates")
    advance(1)
    source.down = true
    expect(await getRates("USD")).toEqual({ base: "USD", EUR: 0.9 })
    expect(source.calls).toBe(2)
  })

  it("runs the function again when the entry it served came from a later base", async () => {
    const { fetchRates, source } = ratesSource()
    const getRates = defineCachedFunction(fetchRates, { base: ["/cache/first", "/cache/second"], getKey: base => base, maxAge: 60, onError, staleIfError: 3600, waitUntil })

    await getRates("USD")
    await settle()
    const first = (await root().getKeys("cache:first")).find(key => key.includes("USD"))!
    await root().removeItem(first)

    advance(120)
    source.down = true
    expect(await getRates("USD")).toEqual({ base: "USD", EUR: 0.9 })
    await settle()
    expect(await root().hasItem(first)).toBe(false)
    expect(await getRates("USD")).toEqual({ base: "USD", EUR: 0.9 })
    expect(source.calls).toBe(3)
  })

  it("keeps the entries of two anonymous functions apart", async () => {
    const getEuro = defineCachedFunction(async () => "EUR", { maxAge: 60, staleIfError: 60, waitUntil })
    const getDollar = defineCachedFunction(async () => "USD", { maxAge: 60, staleIfError: 60, waitUntil })

    expect(await getEuro()).toBe("EUR")
    await settle()
    expect(await getDollar()).toBe("USD")
  })
})

it("rejects a staleIfError that is not a number of seconds", () => {
  expect(() => defineCachedFunction(async () => 1, { staleIfError: -1 })).toThrow(expect.objectContaining({ code: "VITE_HUB_CACHE_STALE_IF_ERROR_INVALID" }))
})

it("keeps a custom storage", async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  kvState.root = createStorage()
  const entries = new Map<string, unknown>()
  const storage: StorageInterface = {
    // SAFETY: the test stores ocache entries only.
    get: <V>(key: string) => (entries.get(key) ?? null) as V | null,
    set: (key, value) => void entries.set(key, value),
  }
  const { fetchRates, source } = ratesSource()
  const getRates = defineCachedFunction(fetchRates, { getKey: base => base, maxAge: 60, onError: () => {}, staleIfError: 3600, storage, waitUntil })

  await getRates("USD")
  await settle()
  expect(entries.size).toBe(1)
  expect(await root().getKeys()).toEqual([])

  advance(120)
  source.down = true
  expect(await getRates("USD")).toEqual({ base: "USD", EUR: 0.9 })
  await settle()
  vi.useRealTimers()
})

it("rejects staleIfError with serialize", () => {
  expect(() => defineCachedFunction(async () => "rates", { serialize: entry => JSON.stringify(entry.value), staleIfError: 60 }))
    .toThrow(expect.objectContaining({ code: "VITE_HUB_CACHE_STALE_IF_ERROR_WITH_SERIALIZE" }))
})
