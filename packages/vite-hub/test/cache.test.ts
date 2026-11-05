import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { applyCacheStorage, resolveCacheStorage } from "../src/cache.ts"

const kvCacheDriver = fileURLToPath(import.meta.resolve("vite-hub/_internal/kv/runtime/nitro-cache"))

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

  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])("rejects inherited driver name %s", driver => {
    // SAFETY: The test passes an unsupported inherited property to exercise runtime validation of user config.
    expect(() => resolveCacheStorage({ driver } as unknown as Parameters<typeof resolveCacheStorage>[0], "node"))
      .toThrow("`cache.driver` must be")
  })
})

describe("applyCacheStorage", () => {
  it("adds the Cloudflare namespace once", () => {
    const cache = resolveCacheStorage({ driver: "cloudflare-kv-binding", namespaceId: "cache-id" }, "cloudflare")
    const once = applyCacheStorage({}, cache)
    const twice = applyCacheStorage({ ...once, kv: {} }, cache)

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

  it("uses Nitro KV mounts in production, development and prerendering", () => {
    const config = applyCacheStorage({
      kv: { sessions: { driver: "memory" } },
      $development: { debug: true, kv: { sessions: { driver: "memory" } } },
      $prerender: { failOnError: true },
    }, resolveCacheStorage(true, "vercel"))

    expect(config).toEqual({
      kv: { cache: { driver: "vercel-runtime-cache" }, sessions: { driver: "memory" } },
      $development: { debug: true, kv: { cache: { base: ".vitehub/data/cache", driver: "fs-lite" }, sessions: { driver: "memory" } } },
      $prerender: { failOnError: true, kv: { cache: { base: ".vitehub/data/cache", driver: "fs-lite" } } },
    })
  })

  it("preserves application cache mounts in each environment without adding a Cloudflare binding", () => {
    const nitro = {
      kv: { cache: { driver: "memory" } },
      $development: { kv: { cache: { base: "dev", driver: "fs-lite" } } },
      $prerender: { kv: { cache: { base: "prerender", driver: "fs-lite" } } },
    }
    expect(applyCacheStorage(nitro, resolveCacheStorage(true, "cloudflare"))).toEqual(nitro)
  })
})

describe("KV cache storage", () => {
  it("mounts Nitro's cache on the app's KV store on any preset", () => {
    const mount = { base: "nitro-cache", driver: kvCacheDriver }
    for (const preset of ["cloudflare", "netlify", "node"] as const) {
      expect(resolveCacheStorage({ driver: "kv" }, preset, true)).toEqual({ devStorage: mount, storage: mount })
    }
    expect(resolveCacheStorage({ base: "pages", driver: "kv" }, "vercel", true).storage).toEqual({ base: "pages", driver: kvCacheDriver })
  })

  it("requires kv", () => {
    expect(() => resolveCacheStorage({ driver: "kv" }, "cloudflare")).toThrow("`kv` is not enabled")
  })

  it("keeps an app's own cache mount and adds no Wrangler namespace", () => {
    const config = applyCacheStorage({ storage: { cache: { driver: "memory" } } }, resolveCacheStorage({ driver: "kv" }, "cloudflare", true))
    const mount = { base: "nitro-cache", driver: kvCacheDriver }
    expect(config).toEqual({
      $development: { kv: { cache: mount } },
      $prerender: { kv: { cache: mount } },
      kv: { cache: { driver: "memory" } },
      storage: { cache: { driver: "memory" } },
    })
  })
})
