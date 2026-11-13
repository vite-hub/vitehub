import { describe, expect, it, vi } from "vitest"

import { kvInferredStoreNotice, kvRedisEnvWarning, normalizeKVOptions, warnVercelKVFallback } from "../src/config.ts"
import { configureCloudflareKV } from "../src/integrations/cloudflare.ts"

describe("normalizeKVOptions", () => {
  it("falls back to fs-lite on Node", () => {
    expect(normalizeKVOptions(undefined, {
      env: {},
      hosting: "",
    })).toEqual({
      store: {
        base: ".vitehub/data/kv",
        driver: "fs-lite",
        inferred: true,
      },
    })
  })

  it("infers the database driver on Node when the app has a Postgres Default Database", () => {
    expect(normalizeKVOptions(undefined, { env: {}, hosting: "node-server", postgresDatabase: true })).toEqual({
      store: { database: "default", driver: "database", inferred: true, namespace: "default" },
    })
  })

  it("keeps an inferred store local in development, also with REDIS_URL and a Postgres Database", () => {
    expect(normalizeKVOptions(undefined, { dev: true, env: { REDIS_URL: "redis://localhost:6379" }, hosting: "node-server", postgresDatabase: true })).toEqual({
      store: { base: ".vitehub/data/kv", driver: "fs-lite" },
    })
  })

  it("ignores REDIS_URL and the Database at build time on hosted presets", () => {
    const env = { REDIS_URL: "redis://localhost:6379" }
    expect(normalizeKVOptions(undefined, { env, hosting: "cloudflare-module", postgresDatabase: true })?.store.driver).toBe("cloudflare-kv-binding")
    expect(normalizeKVOptions(undefined, { env, hosting: "vercel", postgresDatabase: true })?.store.driver).toBe("upstash")
    expect(normalizeKVOptions(undefined, { env, hosting: "deno-deploy", postgresDatabase: true })?.store.driver).toBe("deno-kv")
  })

  it("lets Upstash env at build time beat the Database", () => {
    const env = { KV_REST_API_TOKEN: "token", KV_REST_API_URL: "https://example.upstash.io" }
    expect(normalizeKVOptions(undefined, { env, hosting: "node-server", postgresDatabase: true })?.store.driver).toBe("upstash")
  })

  it("gives every Redis store its own prefix, and never an empty one", () => {
    expect(normalizeKVOptions({ driver: "redis", base: " " }, { env: {} })?.store).toMatchObject({ base: "vitehub:kv:default" })
    expect(normalizeKVOptions({ driver: "redis", base: ":" }, { env: {} })?.store).toMatchObject({ base: "vitehub:kv:default" })
    expect(normalizeKVOptions({ driver: "redis", base: "app/kv" }, { env: {} })?.store).toMatchObject({ base: "app:kv" })
  })

  it("resolves explicit redis and database stores, with a runtime URL and a namespace per store", () => {
    expect(normalizeKVOptions({ stores: {
      default: { driver: "redis" },
      cache: { driver: "redis", url: "env:CACHE_REDIS_URL" },
      sessions: { driver: "database", database: "auth" },
    } }, { env: { REDIS_URL: "redis://build-host:6379" } })).toEqual({
      store: { base: "vitehub:kv:default", driver: "redis", url: "env:REDIS_URL" },
      stores: {
        cache: { base: "vitehub:kv:cache", driver: "redis", url: "env:CACHE_REDIS_URL" },
        default: { base: "vitehub:kv:default", driver: "redis", url: "env:REDIS_URL" },
        sessions: { database: "auth", driver: "database", namespace: "sessions" },
      },
    })
  })
})

describe("build-selected Node stores", () => {
  it.each([false, true])("ignores unrelated REDIS_URL values when Postgres is %s", (postgresDatabase) => {
    const input = { env: {}, hosting: "node-server", postgresDatabase }
    const config = normalizeKVOptions(undefined, input)
    expect(normalizeKVOptions(undefined, { ...input, env: { REDIS_URL: "redis://localhost:6379" } })).toEqual(config)
    expect(config?.store.driver).toBe(postgresDatabase ? "database" : "fs-lite")
  })
})

describe("kvInferredStoreNotice", () => {
  const inferred = { database: "default", driver: "database" as const, inferred: true as const, namespace: "default" }

  it("says which driver this process picked for an inferred store, and why", () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379")
    expect(kvInferredStoreNotice("default", inferred)).toContain("selected at build time")
    vi.stubEnv("REDIS_URL", "")
    expect(kvInferredStoreNotice("default", inferred)).toBe("[vitehub] KV store \"default\" uses the table vitehub_kv of the Database \"default\", selected at build time.")
    expect(kvInferredStoreNotice("default", { base: ".vitehub/data/kv", driver: "fs-lite", inferred: true })).toContain("Other server processes cannot read its keys.")
    vi.unstubAllEnvs()
  })

  it("says nothing for an explicit store", () => {
    expect(kvInferredStoreNotice("default", { base: "vitehub:kv:default", driver: "redis", url: "env:REDIS_URL" })).toBeUndefined()
  })
})

describe("kvRedisEnvWarning", () => {
  const redisEnv = { REDIS_URL: "redis://localhost:6379" }

  it("names REDIS_URL and the fix when a Node build infers fs-lite or the Database", () => {
    expect(kvRedisEnvWarning(undefined, { env: redisEnv, hosting: "node-server" })).toBe(
      "[vitehub] The build has `REDIS_URL`, but KV does not select Redis on its own. The KV store \"default\" uses fs-lite in .vitehub/data/kv. To keep KV in that Redis, set `kv: { driver: \"redis\" }`. To keep this store, set its `driver`.",
    )
    expect(kvRedisEnvWarning({}, { env: redisEnv, hosting: "", postgresDatabase: true })).toContain("uses the table vitehub_kv of the Database \"default\"")
  })

  it("gives the KV_URL fix for a TLS KV_URL", () => {
    const warning = kvRedisEnvWarning(undefined, { env: { KV_URL: "rediss://default:secret@example.com:6380" }, hosting: "node-server" })
    expect(warning).toContain("`kv: { driver: \"redis\", url: \"env:KV_URL\" }`")
    expect(warning).not.toContain("secret")
    expect(kvRedisEnvWarning(undefined, { env: { KV_URL: "redis://localhost:6379" }, hosting: "node-server" })).toBeUndefined()
  })

  it("says that Upstash fails on Vercel when the build has only REDIS_URL", () => {
    const warning = kvRedisEnvWarning(undefined, { env: redisEnv, hosting: "vercel" })
    expect(warning).toContain("KV on Vercel uses Upstash, and the build has no `KV_REST_API_URL` and `KV_REST_API_TOKEN`")
    expect(warning).toContain("`kv: { driver: \"redis\" }`")
    expect(kvRedisEnvWarning(undefined, { env: { ...redisEnv, KV_REST_API_TOKEN: "token", KV_REST_API_URL: "https://example.upstash.io" }, hosting: "vercel" })).toBeUndefined()
  })

  it("stays quiet for an explicit driver, Cloudflare, Deno, dev, and builds without a Redis URL", () => {
    expect(kvRedisEnvWarning({ driver: "fs-lite" }, { env: redisEnv, hosting: "node-server" })).toBeUndefined()
    expect(kvRedisEnvWarning({ stores: { default: { driver: "database" } } }, { env: redisEnv, hosting: "node-server" })).toBeUndefined()
    expect(kvRedisEnvWarning(false, { env: redisEnv, hosting: "node-server" })).toBeUndefined()
    expect(kvRedisEnvWarning(undefined, { env: redisEnv, hosting: "cloudflare-module" })).toBeUndefined()
    expect(kvRedisEnvWarning(undefined, { env: redisEnv, hosting: "deno-deploy" })).toBeUndefined()
    expect(kvRedisEnvWarning(undefined, { dev: true, env: redisEnv, hosting: "node-server" })).toBeUndefined()
    expect(kvRedisEnvWarning(undefined, { env: {}, hosting: "node-server" })).toBeUndefined()
  })
})

describe("normalizeKVOptions existing behavior", () => {

  it("lets explicit config beat hosting defaults", () => {
    expect(normalizeKVOptions({
      base: ".cache/custom-kv",
      driver: "fs-lite",
    }, {
      env: {
        KV_NAMESPACE_ID: "namespace-from-env",
      },
      hosting: "cloudflare-pages",
    })).toEqual({
      store: {
        base: ".cache/custom-kv",
        driver: "fs-lite",
      },
    })
  })

  it("uses Cloudflare defaults when hosting resolves to Cloudflare", () => {
    expect(normalizeKVOptions(undefined, {
      env: {
        KV_NAMESPACE_ID: "namespace-from-env",
      },
      hosting: "cloudflare-module",
    })).toEqual({
      store: {
        binding: "KV",
        driver: "cloudflare-kv-binding",
        namespaceId: "namespace-from-env",
      },
    })
  })

  it("uses Deno KV defaults when hosting resolves to Deno", () => {
    expect(normalizeKVOptions(undefined, {
      env: {},
      hosting: "deno-deploy",
    })).toEqual({
      store: {
        driver: "deno-kv",
      },
    })
  })

  it("lets Deno hosting beat ambient Upstash credentials", () => {
    expect(normalizeKVOptions(undefined, {
      env: {
        KV_REST_API_TOKEN: "token",
        KV_REST_API_URL: "https://upstash.example.com",
      },
      hosting: "deno",
    })).toEqual({
      store: {
        driver: "deno-kv",
      },
    })
  })

  it("preserves an explicit Deno KV path", () => {
    expect(normalizeKVOptions({
      driver: "deno-kv",
      path: ":memory:",
    }, {
      env: {},
      hosting: "",
    })).toEqual({
      store: {
        driver: "deno-kv",
        path: ":memory:",
      },
    })
  })

  it("uses masked Upstash placeholders for env-detected config", () => {
    expect(normalizeKVOptions(undefined, {
      env: {
        KV_REST_API_TOKEN: "token",
        KV_REST_API_URL: "https://upstash.example.com",
      },
      hosting: "vercel",
    })).toEqual({
      store: {
        driver: "upstash",
        token: "********",
        url: "********",
      },
    })
  })

  it("detects Upstash credentials under the Upstash console names", () => {
    expect(normalizeKVOptions(undefined, {
      env: {
        UPSTASH_REDIS_REST_TOKEN: "token",
        UPSTASH_REDIS_REST_URL: "https://upstash.example.com",
      },
      hosting: "node-server",
    })).toEqual({
      store: {
        driver: "upstash",
        token: "********",
        url: "********",
      },
    })
  })

  it("defaults Vercel hosting to masked Upstash runtime config", () => {
    expect(normalizeKVOptions(undefined, {
      env: {},
      hosting: "vercel",
    })).toEqual({
      store: {
        driver: "upstash",
        token: "********",
        url: "********",
      },
    })
  })

  it("preserves explicit Upstash credentials", () => {
    expect(normalizeKVOptions({
      driver: "upstash",
      token: "explicit-token",
      url: "https://explicit-upstash.example.com",
    }, {
      env: {
        KV_REST_API_TOKEN: "env-token",
        KV_REST_API_URL: "https://env-upstash.example.com",
      },
      hosting: "vercel",
    })).toEqual({
      store: {
        driver: "upstash",
        token: "explicit-token",
        url: "https://explicit-upstash.example.com",
      },
    })
  })

  it("uses masked values for explicit Upstash config without inline credentials", () => {
    expect(normalizeKVOptions({
      driver: "upstash",
    }, {
      env: {
        KV_REST_API_TOKEN: "env-token",
        KV_REST_API_URL: "https://env-upstash.example.com",
      },
      hosting: "vercel",
    })).toEqual({
      store: {
        driver: "upstash",
        token: "********",
        url: "********",
      },
    })
  })

  it("normalizes named stores with a required default store", () => {
    expect(normalizeKVOptions({
      stores: {
        chat: {
          base: ".data/chat-kv",
          driver: "fs-lite",
        },
        default: {
          base: ".vitehub/data/kv",
          driver: "fs-lite",
        },
      },
    }, {
      env: {},
      hosting: "",
    })).toEqual({
      store: {
        base: ".vitehub/data/kv",
        driver: "fs-lite",
      },
      stores: {
        chat: {
          base: ".data/chat-kv",
          driver: "fs-lite",
        },
        default: {
          base: ".vitehub/data/kv",
          driver: "fs-lite",
        },
      },
    })
  })

  it("rejects named stores without a default store", () => {
    expect(() => normalizeKVOptions({
      stores: {
        chat: {
          base: ".data/chat-kv",
          driver: "fs-lite",
        },
      },
    }, {
      env: {},
      hosting: "",
    })).toThrow(expect.objectContaining({ code: "KV_MISSING_DEFAULT_STORE" }))
  })

  it("ignores named stores inherited from an untrusted prototype", () => {
    const options = Object.create({
      stores: {
        default: { base: ".inherited", driver: "fs-lite" },
      },
    })

    expect(normalizeKVOptions(options, { env: {}, hosting: "" })).toEqual({
      store: {
        base: ".vitehub/data/kv",
        driver: "fs-lite",
        inferred: true,
      },
    })
  })

  it("accepts named stores exposed by an accessor", () => {
    const options = {
      get stores() {
        return {
          default: { base: ".vitehub/data/kv", driver: "fs-lite" as const },
        }
      },
    }

    expect(normalizeKVOptions(options, { env: {}, hosting: "" })).toEqual({
      store: {
        base: ".vitehub/data/kv",
        driver: "fs-lite",
      },
      stores: {
        default: {
          base: ".vitehub/data/kv",
          driver: "fs-lite",
        },
      },
    })
  })

  it("preserves proxy-backed named stores access", () => {
    const options = new Proxy({ stores: null }, {
      get(target, property, receiver) {
        if (property === "stores") {
          return { default: { base: ".vitehub/data/kv", driver: "fs-lite" as const } }
        }
        return Reflect.get(target, property, receiver)
      },
    })

    expect(normalizeKVOptions(options as never, { env: {}, hosting: "" })).toEqual({
      store: {
        base: ".vitehub/data/kv",
        driver: "fs-lite",
      },
      stores: {
        default: {
          base: ".vitehub/data/kv",
          driver: "fs-lite",
        },
      },
    })
  })

  it("rejects non-object config", () => {
    expect(() => normalizeKVOptions(true as never, {
      env: {},
      hosting: "",
    })).toThrow("`kv` must be a plain object.")
  })

  it.each([null, [], "stores"])("rejects a non-record stores option: %j", stores => {
    expect(() => normalizeKVOptions({ stores } as never)).toThrow("`kv.stores` must be a plain object.")
  })
})

describe("Cloudflare integration", () => {
  it("registers Wrangler bindings without requiring namespace IDs", () => {
    const target: {
      cloudflare?: {
        wrangler?: {
          kv_namespaces?: Array<{
            binding: string
            id?: string
          }>
        }
      }
    } = {}
    const config = normalizeKVOptions(undefined, {
      env: {},
      hosting: "cloudflare-module",
    })!

    configureCloudflareKV(target, config)

    expect(target.cloudflare!.wrangler!.kv_namespaces).toEqual([{
      binding: "KV",
    }])
  })

  it("registers wrangler namespaces only once", () => {
    const target: {
      cloudflare?: {
        wrangler?: {
          kv_namespaces?: Array<{
            binding: string
            id: string
          }>
        }
      }
    } = {}
    const config = normalizeKVOptions({
      driver: "cloudflare-kv-binding",
      namespaceId: "namespace-id",
    }, {
      env: {},
      hosting: "cloudflare-module",
    })!

    configureCloudflareKV(target, config)
    configureCloudflareKV(target, config)

    expect(target.cloudflare!.wrangler!.kv_namespaces).toEqual([{
      binding: "KV",
      id: "namespace-id",
    }])
  })

  it("reads provisioned namespace ids by store name and lets a configured id win", () => {
    const target: { cloudflare?: { wrangler?: { kv_namespaces?: Array<{ binding: string, id?: string }> } } } = {}
    const config = normalizeKVOptions({
      stores: {
        default: { binding: "CACHE", driver: "cloudflare-kv-binding", namespaceName: "app-cache" },
        pinned: { binding: "PINNED", driver: "cloudflare-kv-binding", namespaceId: "configured-id", namespaceName: "pinned" },
        unrecorded: { binding: "UNRECORDED", driver: "cloudflare-kv-binding", namespaceName: "unrecorded" },
      },
    }, {
      env: {},
      hosting: "cloudflare-module",
    })!

    configureCloudflareKV(target, config, {
      cloudflare: { kv: { default: "provisioned-cache", pinned: "provisioned-pinned" } },
      vercel: { kv: { unrecorded: "vercel-id" } },
    })

    expect(target.cloudflare!.wrangler!.kv_namespaces).toEqual([
      { binding: "CACHE", id: "provisioned-cache" },
      { binding: "PINNED", id: "configured-id" },
      { binding: "UNRECORDED" },
    ])
  })
})

describe("warnVercelKVFallback", () => {
  it("reports explicit fs-lite on Vercel hosting", () => {
    const error = vi.fn()

    warnVercelKVFallback({
      logger: { error },
    }, normalizeKVOptions({
      driver: "fs-lite",
    }), "vercel")

    expect(error).toHaveBeenCalledWith(
      "Vercel hosting requires Upstash-backed KV. Set `KV_REST_API_URL` and `KV_REST_API_TOKEN`.",
    )
  })

  it("reports named fs-lite stores on Vercel hosting", () => {
    const error = vi.fn()

    warnVercelKVFallback({
      logger: { error },
    }, normalizeKVOptions({
      stores: {
        chat: {
          base: ".data/chat",
          driver: "fs-lite",
        },
        default: {
          driver: "upstash",
        },
      },
    }), "vercel")

    expect(error).toHaveBeenCalledWith(
      "Vercel hosting requires Upstash-backed KV. Set `KV_REST_API_URL` and `KV_REST_API_TOKEN`.",
    )
  })
})
