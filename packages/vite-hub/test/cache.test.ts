import { describe, expect, it } from "vitest"

import { applyCacheStorage, resolveCacheStorage } from "../src/cache.ts"

describe("resolveCacheStorage", () => {
  it("applies explicit binding, namespace, and base options", () => {
    expect(resolveCacheStorage({ binding: "PAGE_CACHE", driver: "cloudflare-kv-binding", namespaceId: "ns-1" }, "cloudflare")).toEqual({
      cloudflareNamespace: { binding: "PAGE_CACHE", id: "ns-1" },
      devStorage: { base: ".vitehub/data/cache", driver: "fs-lite" },
      storage: { binding: "PAGE_CACHE", driver: "cloudflare-kv-binding" },
    })
    expect(resolveCacheStorage({ base: "/var/cache/app", driver: "fs-lite" }, "node")).toEqual({
      devStorage: { base: "/var/cache/app", driver: "fs-lite" },
      storage: { base: "/var/cache/app", driver: "fs-lite" },
    })
    expect(resolveCacheStorage({ base: "pages", driver: "deno-kv" }, "deno").storage).toEqual({ base: "pages", driver: "deno-kv" })
  })

  it("rejects unknown drivers", () => {
    // SAFETY: The test passes an unsupported driver to exercise runtime validation of user config.
    expect(() => resolveCacheStorage({ driver: "redis" } as unknown as Parameters<typeof resolveCacheStorage>[0], "node"))
      .toThrow("`cache.driver` must be")
  })
})

describe("applyCacheStorage", () => {
  it("adds the Cloudflare namespace once", () => {
    const cache = resolveCacheStorage({ driver: "cloudflare-kv-binding", namespaceId: "cache-id" }, "cloudflare")
    const once = applyCacheStorage({}, cache)
    const twice = applyCacheStorage({ ...once, storage: {} }, cache)

    expect(twice).toHaveProperty("cloudflare.wrangler.kv_namespaces", [{ binding: "CACHE", id: "cache-id" }])
  })

  it("preserves an explicit Cloudflare namespace ID when the binding already exists", () => {
    const cache = resolveCacheStorage({ driver: "cloudflare-kv-binding", namespaceId: "cache-id" }, "cloudflare")
    const config = applyCacheStorage({
      cloudflare: { wrangler: { kv_namespaces: [{ binding: "CACHE" }] } },
    }, cache)

    expect(config).toHaveProperty("cloudflare.wrangler.kv_namespaces", [{ binding: "CACHE", id: "cache-id" }])
  })

  it("rejects a Cloudflare cache without a namespace ID", () => {
    expect(() => applyCacheStorage({}, resolveCacheStorage(true, "cloudflare")))
      .toThrow("needs a namespace ID")
  })

  it("rejects a conflicting existing Cloudflare namespace ID", () => {
    const cache = resolveCacheStorage({ driver: "cloudflare-kv-binding", namespaceId: "cache-id" }, "cloudflare")
    expect(() => applyCacheStorage({
      cloudflare: { wrangler: { kv_namespaces: [{ binding: "CACHE", id: "other-id" }] } },
    }, cache)).toThrow("already uses namespace")
  })
})
