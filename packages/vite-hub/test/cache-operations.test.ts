import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { collectOperationContributions, operationCliPath, operationsOf } from "@vite-hub/internal/operations"

import type { CacheStorage } from "../src/cache/entries.ts"

// Keys and entries as Nitro 3 writes them: the cache library prefixes `/cache` and the group `nitro/functions`, which
// it escapes to `nitrofunctions.<hash>`, so the `cache` mount holds `<group>:<name>:<key>.json`.
const now = Date.now()
const entries = {
  "nitrofunctions.Cm3ZWo:getStars:a1.json": { expires: now + 60_000, integrity: "x", mtime: now, value: { stars: 42 } },
  "nitrofunctions.Cm3ZWo:getStars:b2.json": { expires: now - 1_000, integrity: "x", mtime: now - 61_000, value: { stars: 41 } },
  "nitrohandlers.Rk2Tn0:posts:posts.S8IZ.json": { integrity: "y", mtime: now, value: { body: "[]", headers: {}, status: 200 } },
}

/** The `cache` mount as `useStorage("cache")` returns it: keys without the mount base, JSON values parsed. */
function cacheMount(): CacheStorage {
  const items = new Map<string, unknown>(Object.entries(entries).map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]))
  return {
    getItem: async key => items.get(key) ?? null,
    // As unstorage does: a base matches whole key segments.
    getKeys: async (base = "") => [...items.keys()].filter(key => !base || key.startsWith(`${base.replace(/:$/, "")}:`)),
    hasItem: async key => items.has(key),
    removeItem: async (key) => { items.delete(key) },
  }
}

const mount = vi.hoisted(() => ({ storage: undefined as CacheStorage | undefined, base: [] as string[] }))
vi.mock("nitro/storage", () => ({
  useStorage: (base: string) => {
    mount.base.push(base)
    return mount.storage
  },
}))

import { cacheOperations } from "../src/cache/operations.ts"
import { viteHubCachePlugin } from "../src/cache/vite.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

async function call(operation: string, input: Record<string, unknown>) {
  const response = await handleConsoleRpcRequest(new Request("http://localhost/_vitehub/rpc", {
    body: operationRpcBody(operation, input),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
  }), { remoteAddress: "127.0.0.1" })
  return { body: await operationRpcResponseResult(response), status: response.status }
}

beforeEach(() => {
  mount.storage = cacheMount()
  mount.base = []
  installConsoleSections("/project", ["cache", "kv"], ["cache", "kv"])
  installConsoleOperations([{ operations: cacheOperations, plugin: "vite-hub" }])
})

afterEach(() => {
  installConsoleAccess({ mode: "open" })
  installConsoleOperations([])
  installConsoleSections("/project", [])
})

describe("cache operations", () => {
  it("are the `vitehub cache` commands of the cache plugin", async () => {
    const contributed = await collectOperationContributions([viteHubCachePlugin()])
    const operations = operationsOf(await contributed[0]!.load!())
    expect(operations.map(operation => `${operationCliPath(operation).namespace} ${operationCliPath(operation).command}`)).toEqual(["cache list", "cache get", "cache delete"])
    expect(operations.map(operation => [operation.name, operation.kind, operation.section])).toEqual([
      ["cache.list", "read", "cache"],
      ["cache.get", "read", "cache"],
      ["cache.delete", "destructive", "cache"],
    ])
  })

  it("lists entries of Nitro's cache mount with group, name, size, and expiry, one page at a time", async () => {
    const first = await call("cache.list", { limit: 2 })
    expect(first.status).toBe(200)
    expect(mount.base).toContain("cache")
    expect(first.body).toMatchObject({
      ok: true,
      value: {
        cursor: "nitrofunctions.Cm3ZWo:getStars:b2.json",
        entries: [
          { expired: false, expires: new Date(now + 60_000).toISOString(), group: "functions", key: "nitrofunctions.Cm3ZWo:getStars:a1.json", mtime: new Date(now).toISOString(), name: "getStars", size: expect.any(Number) },
          { expired: true, group: "functions", key: "nitrofunctions.Cm3ZWo:getStars:b2.json", name: "getStars" },
        ],
        limit: 2,
        prefix: "",
      },
    })
    const next = await call("cache.list", { cursor: "nitrofunctions.Cm3ZWo:getStars:b2.json", limit: 2 })
    expect(next.body).toMatchObject({ ok: true, value: { entries: [{ group: "handlers", key: "nitrohandlers.Rk2Tn0:posts:posts.S8IZ.json", name: "posts" }] } })
    expect((next.body as { value: { cursor?: string } }).value.cursor).toBeUndefined()

    const handlers = await call("cache.list", { prefix: "nitrohandlers" })
    expect((handlers.body as { value: { entries: unknown[] } }).value.entries).toHaveLength(1)
    expect((await call("cache.list", { limit: 101 })).status).toBe(400)
  })

  it("reads one entry and its value", async () => {
    expect((await call("cache.get", { key: "nitrofunctions.Cm3ZWo:getStars:a1.json" })).body).toMatchObject({
      ok: true,
      value: { entry: { group: "functions", name: "getStars" }, found: true, value: "{\"stars\":42}" },
    })
    expect((await call("cache.get", { key: "missing.json" })).body).toMatchObject({ ok: true, value: { found: false, key: "missing.json" } })
  })

  it("invalidates one entry or every entry under a prefix, and never the whole cache", async () => {
    const storage = mount.storage!
    expect((await call("cache.delete", { key: "nitrohandlers.Rk2Tn0:posts:posts.S8IZ.json" })).body).toMatchObject({ ok: true, value: { deleted: 1 } })
    expect(await storage.hasItem("nitrohandlers.Rk2Tn0:posts:posts.S8IZ.json")).toBe(false)

    expect((await call("cache.delete", { prefix: "nitrofunctions.Cm3ZWo:getStars" })).body).toMatchObject({ ok: true, value: { deleted: 2, prefix: "nitrofunctions.Cm3ZWo:getStars" } })
    expect(await storage.getKeys()).toEqual([])

    expect((await call("cache.delete", {})).body).toMatchObject({ code: "CACHE_INVALID_INPUT", ok: false, status: 400 })
    expect((await call("cache.delete", { prefix: ":" })).body).toMatchObject({ code: "CACHE_INVALID_INPUT", ok: false })
  })

  it("reports a driver that cannot list keys", async () => {
    mount.storage = { ...cacheMount(), getKeys: () => Promise.reject(new Error("getKeys is not supported")) }
    expect((await call("cache.list", {})).body).toMatchObject({ code: "CACHE_STORAGE_FAILED", ok: false, status: 502 })
  })

  it("follows the section grants of console.authorize", async () => {
    installConsoleAccess({ authorize: () => ({ sections: ["kv"] }), mode: "open" })
    expect((await call("cache.list", {})).status).toBe(403)

    installConsoleAccess({ authorize: () => ({ sections: ["cache:read"] }), mode: "open" })
    expect((await call("cache.list", {})).status).toBe(200)
    expect((await call("cache.get", { key: "nitrohandlers.Rk2Tn0:posts:posts.S8IZ.json" })).status).toBe(200)
    expect((await call("cache.delete", { key: "nitrohandlers.Rk2Tn0:posts:posts.S8IZ.json" })).status).toBe(403)
    expect(await mount.storage!.hasItem("nitrohandlers.Rk2Tn0:posts:posts.S8IZ.json")).toBe(true)
  })
})
