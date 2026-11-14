import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { H3 } from "nitro/h3"
import type { CacheOptions, CachedEventHandlerOptions, EventHandler as OcacheEventHandler, HTTPEvent, StorageInterface } from "ocache"
import { createStorage, prefixStorage, type Driver, type Storage } from "unstorage"
import fsLite from "unstorage/drivers/fs-lite"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { defineCachedFunction, defineCachedHandler, invalidateTag } from "../src/cache.ts"

const kvState = vi.hoisted(() => ({ root: undefined as Storage | undefined }))

function root(): Storage {
  if (!kvState.root) throw new TypeError("The test KV store is not set.")
  return kvState.root
}

// `nitro/kv` and `nitro/cache` read Nitro's generated modules. These mocks wire them the way a Nitro build does with
// a `cache` mount: `useKV()` is one unstorage instance, and the cache uses Nitro's `cache.driver: "kv"` adapter.
vi.mock("nitro/kv", () => ({
  useKV: (base = "") => base ? prefixStorage(root(), base) : root(),
}))

vi.mock("nitro/cache", async () => {
  const ocache = await import("ocache")
  const { defineHandler, toResponse } = await import("nitro/h3")
  const storage = (): StorageInterface => ({
    // SAFETY: Nitro's adapter returns what unstorage parsed. The cache checks the entry shape when it reads it.
    get: <T>(key: string) => root().getItem(key) as Promise<T | null>,
    set: (key, value, opts) => root().setItem(key, JSON.parse(JSON.stringify(value)), opts?.ttl ? { ttl: opts.ttl } : undefined),
  })
  return {
    defineCachedFunction: <T, ArgsT extends unknown[]>(fn: (...args: ArgsT) => T | Promise<T>, opts: CacheOptions<T, ArgsT> = {}) =>
      ocache.defineCachedFunction(fn, { group: "nitro/functions", storage, ...opts }),
    defineCachedHandler: (handler: OcacheEventHandler, opts: CachedEventHandlerOptions = {}) => {
      const cached = ocache.defineCachedHandler(handler, { group: "nitro/handlers", storage, toResponse: (value, event) => toResponse(value, event as never), ...opts })
      return defineHandler(event => cached(event as HTTPEvent))
    },
  }
})

/** A Cloudflare-KV-like driver: string values only, and no key listing. */
function fakeKV(): Driver {
  const data = new Map<string, string>()
  const noScan = () => {
    throw new TypeError("fake-kv cannot list keys")
  }
  return {
    name: "fake-kv",
    hasItem: key => data.has(key),
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: key => void data.delete(key),
    getKeys: noScan,
    clear: noScan,
  }
}

const pending: Promise<unknown>[] = []
const waitUntil = (promise: Promise<unknown>) => void pending.push(promise)
/** Waits for the cache writes that ocache runs in the background. */
async function settle() {
  while (pending.length) await Promise.all(pending.splice(0))
}

/** Moves the clock, so each step has its own millisecond. */
function tick(ms = 10) {
  vi.setSystemTime(Date.now() + ms)
}

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { force: true, recursive: true })
})

describe.each([
  ["fs-lite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vitehub-cache-tags-"))
    dirs.push(dir)
    return fsLite({ base: dir })
  }],
  ["fake KV", async () => fakeKV()],
])("cache tags on %s", (_name, driver) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    kvState.root = createStorage()
    kvState.root.mount("cache", await driver())
  })

  afterEach(async () => {
    await settle()
    vi.useRealTimers()
  })

  it("runs a tagged function again after invalidateTag() and keeps untagged entries", async () => {
    let posts = 0
    let users = 0
    const getPosts = defineCachedFunction(async () => ++posts, { maxAge: 3600, name: "posts", tags: ["posts"], waitUntil })
    const getUsers = defineCachedFunction(async () => ++users, { maxAge: 3600, name: "users", waitUntil })

    expect(await getPosts()).toBe(1)
    expect(await getUsers()).toBe(1)
    await settle()
    tick()
    expect(await getPosts()).toBe(1)

    await invalidateTag("posts")
    tick()
    expect(await getPosts()).toBe(2)
    expect(await getUsers()).toBe(1)
    await settle()
    tick()
    expect(await getPosts()).toBe(2)
  })

  it("computes tags from the arguments", async () => {
    const calls: string[] = []
    const getPost = defineCachedFunction(async (id: string) => {
      calls.push(id)
      return `post ${id} v${calls.length}`
    }, { getKey: id => id, maxAge: 3600, name: "post", tags: id => ["posts", `post:${id}`], waitUntil })

    await getPost("1")
    await getPost("2")
    await settle()
    tick()
    await invalidateTag(["post:1"])
    tick()
    expect(await getPost("1")).toBe("post 1 v3")
    expect(await getPost("2")).toBe("post 2 v2")
    expect(calls).toEqual(["1", "2", "1"])
  })

  it("does not serve a stale value of an invalidated swr entry", async () => {
    let version = 0
    const getPage = defineCachedFunction(async () => ++version, { maxAge: 3600, name: "page", swr: true, tags: ["pages"], waitUntil })

    expect(await getPage()).toBe(1)
    await settle()
    tick()
    expect(await getPage()).toBe(1)

    await invalidateTag("pages")
    tick()
    expect(await getPage()).toBe(2)
    await settle()
    tick()
    expect(await getPage()).toBe(2)
  })

  it("keeps a result out of the cache when its tag is invalidated while the function runs", async () => {
    let version = 0
    let release = () => {}
    let started = () => {}
    const running = new Promise<void>(done => (started = done))
    const getPost = defineCachedFunction(async () => {
      const value = ++version
      if (value === 1) {
        started()
        await new Promise<void>(done => (release = done))
      }
      return value
    }, { maxAge: 3600, name: "slow", tags: ["posts"], waitUntil })

    const first = getPost()
    await running
    tick()
    await invalidateTag("posts")
    tick()
    release()
    expect(await first).toBe(1)
    await settle()
    tick()
    expect(await getPost()).toBe(2)
  })

  it.each(["function", "handler"])("fences overlapping %s calls after invalidation", async (kind) => {
    let version = "old"
    let runs = 0
    let release = () => {}
    let started = () => {}
    const running = new Promise<void>(done => (started = done))
    const compute = async () => {
      const value = version
      if (++runs === 1) {
        started()
        await new Promise<void>(done => (release = done))
      }
      return value
    }
    const options = { maxAge: 3600, name: "overlap", tags: ["posts"], waitUntil }
    const fn = defineCachedFunction(compute, options)
    const app = new H3().get("/", defineCachedHandler(compute, options))
    const call = () => kind === "function" ? fn() : app.fetch(new Request("http://test/")).then(response => response.text())
    const first = call()
    await running
    tick()
    version = "new"
    await invalidateTag("posts")
    tick()
    const second = call()
    release()
    expect(await first).toBe("old")
    expect(await second).toBe("new")
    await settle()
    tick()
    expect(await call()).toBe("new")
    expect(runs).toBe(2)
  })

  it("caches a tagged handler response, runs it again after invalidateTag(), and hides the tag header", async () => {
    let tagged = 0
    let untagged = 0
    const app = new H3()
      .get("/posts/:id", defineCachedHandler(event => `post ${event.context.params?.id} v${++tagged}`, {
        maxAge: 3600,
        tags: event => ["posts", `post:${event.context.params?.id}`],
        waitUntil,
      }))
      .get("/about", defineCachedHandler(() => `about v${++untagged}`, { maxAge: 3600, waitUntil }))
    const get = async (path: string) => {
      const response = await app.fetch(new Request(`http://localhost${path}`))
      expect(response.headers.has("x-vitehub-cache-tags")).toBe(false)
      return response.text()
    }

    expect(await get("/posts/1")).toBe("post 1 v1")
    expect(await get("/posts/2")).toBe("post 2 v2")
    expect(await get("/about")).toBe("about v1")
    await settle()
    tick()
    expect(await get("/posts/1")).toBe("post 1 v1")

    await invalidateTag("post:1")
    tick()
    expect(await get("/posts/1")).toBe("post 1 v3")
    expect(await get("/posts/2")).toBe("post 2 v2")
    expect(await get("/about")).toBe("about v1")
    await settle()
    tick()
    expect(await get("/posts/1")).toBe("post 1 v3")

    await invalidateTag(["posts"])
    tick()
    expect(await get("/posts/2")).toBe("post 2 v4")
    expect(await get("/about")).toBe("about v1")
  })

  it("rejects empty tags with a diagnostic", async () => {
    await expect(invalidateTag("")).rejects.toThrow("Cache tags must be non-empty strings")
    const broken = defineCachedFunction(async () => 1, { name: "broken", tags: () => [""], waitUntil })
    await expect(broken()).rejects.toMatchObject({ code: "VITE_HUB_R0145" })
  })
})
