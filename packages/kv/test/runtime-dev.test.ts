import { rm } from "node:fs/promises"

import { afterAll, describe, expect, it, vi } from "vitest"

import { kv } from "../src/index.ts"
import { kvDevHeader, kvDevHeaderValue } from "../src/dev.ts"
import { handleKVDevRequest, listKVDevStores } from "../src/runtime/dev.ts"

const roots = vi.hoisted(() => {
  const base = `${process.env.TMPDIR || "/tmp"}/vitehub-kv-dev-${process.pid}-${Date.now()}`
  return { archive: `${base}/archive`, base, cache: `${base}/cache`, default: `${base}/default` }
})

vi.mock("#vitehub/kv/config", () => ({
  hosting: undefined,
  kv: {
    store: { base: roots.default, driver: "fs-lite" },
    stores: {
      cache: { base: roots.cache, driver: "fs-lite" },
      default: { base: roots.default, driver: "fs-lite" },
      archive: { base: roots.archive, driver: "fs-lite" },
    },
  },
}))

// The runtime handler imports the package entry, so the test runs the real KV storage on fs-lite.
vi.mock("@vite-hub/kv", async () => await import("../src/index.ts"))

afterAll(async () => {
  await rm(roots.base, { force: true, recursive: true })
})

function devRequest(body: unknown, init: { headers?: Record<string, string>, method?: string } = {}): Request {
  const method = init.method ?? "POST"
  return new Request("http://localhost/_vitehub/kv/dev", {
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", [kvDevHeader]: kvDevHeaderValue, ...init.headers },
    method,
  })
}

async function run(body: unknown): Promise<{ body: Record<string, unknown>, status: number }> {
  const response = await handleKVDevRequest(devRequest(body))
  expect(response.headers.get("cache-control")).toBe("no-store")
  return { body: await response.json() as Record<string, unknown>, status: response.status }
}

describe("KV dev runtime handler", () => {
  it.each(["get", "has", "set", "del"] as const)("passes empty keys through the %s runtime operation", async operation => {
    const get = vi.spyOn(kv, "get").mockResolvedValue([undefined, "empty key"])
    const has = vi.spyOn(kv, "has").mockResolvedValue([undefined, true])
    const set = vi.spyOn(kv, "set").mockResolvedValue([undefined, undefined])
    const del = vi.spyOn(kv, "del").mockResolvedValue([undefined, undefined])
    try {
      expect(await run({ key: "", operation, ...(operation === "set" ? { value: "empty key" } : {}) })).toMatchObject({ status: 200, body: { key: "" } })
      const storageCall = { get, has, set, del }[operation]
      expect(storageCall.mock.calls[0]?.[0]).toBe("")
      expect((await run({ operation, ...(operation === "set" ? { value: "empty key" } : {}) })).status).toBe(400)
    }
    finally { get.mockRestore(); has.mockRestore(); set.mockRestore(); del.mockRestore() }
  })

  it("rejects accessor-backed values without running their getters", async () => {
    const getter = vi.fn(() => { throw new Error("Getter must not run") })
    const value = Object.defineProperty({}, "secret", { enumerable: true, get: getter })
    const get = vi.spyOn(kv, "get").mockResolvedValue([undefined, value])
    try {
      expect(await run({ key: "native", operation: "get" })).toMatchObject({ status: 422, body: { error: { code: "KV_VALUE_UNSUPPORTED" } } })
      expect(getter).not.toHaveBeenCalled()
    }
    finally { get.mockRestore() }
  })

  it.each([undefined, new Map([["role", "admin"]]), Number.NaN, Number.POSITIVE_INFINITY, { nested: undefined }, [undefined], new Date("2026-01-01"), Object.assign(["entry"], { extra: "lost" }), Object.assign(["entry"], { [Symbol("extra")]: "lost" }), Object.defineProperty({}, "hidden", { value: "lost" })])("rejects native values that JSON would change: %j", async value => {
    const get = vi.spyOn(kv, "get").mockResolvedValue([undefined, value])
    try {
      expect(await run({ key: "native", operation: "get" })).toMatchObject({ status: 422, body: { error: { code: "KV_VALUE_UNSUPPORTED" } } })
    }
    finally { get.mockRestore() }
  })

  it("represents native bigint values and rejects cyclic values with a protocol error", async () => {
    const get = vi.spyOn(kv, "get")
    try {
      get.mockResolvedValue([undefined, 9007199254740993n])
      expect((await run({ key: "native", operation: "get" })).body).toMatchObject({ found: true, type: "bigint", value: "9007199254740993" })
      get.mockResolvedValue([undefined, { nested: [42n] }])
      expect((await run({ key: "native", operation: "get" })).body).toMatchObject({ value: { nested: ["42"] } })
      const cyclic: { self?: unknown } = {}
      cyclic.self = cyclic
      get.mockResolvedValue([undefined, cyclic])
      expect(await run({ key: "native", operation: "get" })).toMatchObject({ status: 422, body: { error: { code: "KV_VALUE_UNSUPPORTED" } } })
    }
    finally { get.mockRestore() }
  })

  it("reports the effective Cloudflare TTL when fractional seconds are rounded", async () => {
    const set = vi.spyOn(kv, "set").mockResolvedValue([undefined, undefined])
    try {
      const response = await handleKVDevRequest(devRequest({ key: "fractional", operation: "set", ttl: 60.5, value: "x" }), [{ driver: "cloudflare-kv-binding", name: "default" }])
      expect(set).toHaveBeenCalledWith("fractional", "x", { ttl: 61 })
      expect(await response.json()).toMatchObject({ ttl: 61, notice: expect.stringContaining("61 seconds") })
    }
    finally { set.mockRestore() }
  })

  it("lists stores in the Console order", () => {
    expect(listKVDevStores()).toEqual([
      { driver: "fs-lite", name: "default" },
      { driver: "fs-lite", name: "archive" },
      { driver: "fs-lite", name: "cache" },
    ])
  })

  it("writes, reads, lists, and deletes keys in the real storage", async () => {
    expect(await run({ key: "settings", operation: "set", value: { theme: "dark" } })).toEqual({
      body: { created: true, key: "settings", store: "default", type: "object" },
      status: 200,
    })
    expect((await run({ key: "settings", operation: "set", ttl: 30, value: "light" })).body).toEqual({
      created: false,
      key: "settings",
      notice: "The fs-lite driver ignores TTL. The value does not expire.",
      store: "default",
      ttl: 30,
      type: "string",
    })
    expect((await run({ key: "settings", operation: "get" })).body).toEqual({ found: true, key: "settings", store: "default", type: "string", value: "light" })
    expect((await run({ key: "settings", operation: "has" })).body).toEqual({ exists: true, key: "settings", store: "default" })

    await run({ key: "users:1", operation: "set", value: "Ada" })
    await run({ key: "users:2", operation: "set", value: "Grace" })
    const first = await run({ limit: 1, operation: "list", prefix: "users" })
    expect(first.body).toMatchObject({ limit: 1, prefix: "users", store: "default", stores: ["default", "archive", "cache"] })
    // fs-lite counts scanned entries, so a page can hold fewer keys than the limit. The cursor reads the rest.
    const keys = [...first.body.keys as string[]]
    let cursor = first.body.cursor
    for (let page = 0; cursor && page < 10; page += 1) {
      const next = await run({ cursor, limit: 1, operation: "list", prefix: "users" })
      keys.push(...next.body.keys as string[])
      cursor = next.body.cursor
    }
    expect(cursor).toBeUndefined()
    expect(keys.sort()).toEqual(["users:1", "users:2"])

    expect((await run({ key: "settings", operation: "del" })).body).toEqual({ deleted: true, key: "settings", store: "default" })
    expect((await run({ key: "settings", operation: "del" })).body).toEqual({ deleted: false, key: "settings", store: "default" })
    expect((await run({ key: "settings", operation: "get" })).body).toEqual({ found: false, key: "settings", store: "default" })
    expect((await run({ key: "settings", operation: "has" })).body).toEqual({ exists: false, key: "settings", store: "default" })
  })

  it("deletes an existing value despite a stale missing-key probe", async () => {
    expect((await run({ key: "stale-delete", operation: "set", value: "remove me" })).status).toBe(200)
    const has = vi.spyOn(kv, "has").mockResolvedValue([undefined, false])
    try {
      expect((await run({ key: "stale-delete", operation: "del" })).body).toEqual({ deleted: false, key: "stale-delete", store: "default" })
      expect((await run({ key: "stale-delete", operation: "get" })).body).toMatchObject({ found: false })
    }
    finally { has.mockRestore() }
  })

  it("accepts fractional TTLs and rejects empty stores without mutating default storage", async () => {
    expect((await run({ key: "fractional", operation: "set", ttl: 1.5, value: "x" })).status).toBe(200)
    expect((await run({ key: "empty-store", operation: "set", store: "", value: "x" })).status).toBe(400)
    expect((await run({ key: "empty-store", operation: "has" })).body).toMatchObject({ exists: false })
  })

  it.each([0.001, 0.5])("rejects sub-second Upstash TTL without writing: %s", async ttl => {
    const set = vi.spyOn(kv, "set").mockResolvedValue([undefined, undefined])
    try {
      const response = await handleKVDevRequest(devRequest({ key: "short", operation: "set", ttl, value: "x" }), [{ driver: "upstash", name: "default" }])
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { message: "Upstash TTL must be at least 1 second." } })
      expect(set).not.toHaveBeenCalled()
    }
    finally { set.mockRestore() }
  })

  it("rounds fractional Upstash TTL before storage and reports the effective seconds", async () => {
    const set = vi.spyOn(kv, "set").mockResolvedValue([undefined, undefined])
    try {
      const response = await handleKVDevRequest(devRequest({ key: "rounded", operation: "set", ttl: 1.5, value: "x" }), [{ driver: "upstash", name: "default" }])
      expect(set).toHaveBeenCalledWith("rounded", "x", { ttl: 2 })
      expect(await response.json()).toMatchObject({ ttl: 2, notice: expect.stringContaining("2 seconds") })
    }
    finally { set.mockRestore() }
  })

  it("clamps Cloudflare TTL before calling storage", async () => {
    const set = vi.spyOn(kv, "set").mockResolvedValue([undefined, undefined])
    try {
      const response = await handleKVDevRequest(devRequest({ key: "clamped", operation: "set", ttl: 1.5, value: "x" }), [{ driver: "cloudflare-kv-binding", name: "default" }])
      expect(response.status).toBe(200)
      expect(set).toHaveBeenCalledWith("clamped", "x", { ttl: 60 })
      expect(await response.json()).toMatchObject({ ttl: 60, notice: expect.stringContaining("60 seconds") })
    }
    finally {
      set.mockRestore()
    }
  })

  it("keeps named stores apart", async () => {
    await run({ key: "report", operation: "set", store: "archive", value: "q2" })
    expect((await run({ key: "report", operation: "get", store: "archive" })).body).toMatchObject({ found: true, value: "q2" })
    expect((await run({ key: "report", operation: "has" })).body).toMatchObject({ exists: false, store: "default" })
    expect((await run({ operation: "list", store: "archive" })).body).toMatchObject({ keys: ["report"], store: "archive" })
  })

  it("rejects unknown stores, bad bodies, and expired cursors", async () => {
    expect(await run({ key: "a", operation: "get", store: "missing" })).toEqual({
      body: { error: { code: "KV_STORE_NOT_FOUND", message: "KV store \"missing\" was not found. Stores: default, archive, cache." } },
      status: 404,
    })
    expect((await run({ operation: "clear" })).status).toBe(400)
    expect((await run("not json")).status).toBe(400)
    expect(await run({ operation: "get" })).toEqual({ body: { error: { message: "The get operation requires a key." } }, status: 400 })
    expect((await run({ key: "a", operation: "set" })).status).toBe(400)
    expect((await run({ key: "a", operation: "set", ttl: 0, value: "x" })).status).toBe(400)
    expect((await run({ limit: 5_000, operation: "list" })).status).toBe(400)
    expect((await run({ cursor: "not-a-cursor", limit: 1, operation: "list" })).body).toMatchObject({ error: { code: "KV_INVALID_CURSOR" } })
  })

  it("reports disabled KV", async () => {
    const response = await handleKVDevRequest(devRequest({ key: "a", operation: "get" }), [])
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: "KV_DISABLED" } })
  })

  it("rejects requests without the guard header, from another origin, or with the wrong method", async () => {
    expect((await handleKVDevRequest(devRequest({ operation: "list" }, { headers: { [kvDevHeader]: "" } }))).status).toBe(403)
    expect((await handleKVDevRequest(devRequest({ operation: "list" }, { headers: { origin: "https://attacker.test" } }))).status).toBe(403)
    expect((await handleKVDevRequest(devRequest({ operation: "list" }, { headers: { "content-type": "text/plain" } }))).status).toBe(415)
    expect((await handleKVDevRequest(devRequest(undefined, { method: "GET" }))).status).toBe(405)
  })
})
