import { describe, expect, it, vi } from "vitest"

import { normalizeKVOptions, warnVercelKVFallback } from "../src/config.ts"
import { configureCloudflareKV } from "../src/integrations/cloudflare.ts"

describe("normalizeKVOptions", () => {
  it("falls back to fs-lite locally", () => {
    expect(normalizeKVOptions(undefined, {
      env: {},
      hosting: "",
    })).toEqual({
      store: {
        base: ".vitehub/data/kv",
        driver: "fs-lite",
      },
    })
  })

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
    })).toThrow("`kv.stores.default` is required when using named KV stores.")
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
      },
    })
  })

  it("rejects non-object config", () => {
    expect(() => normalizeKVOptions(true as never, {
      env: {},
      hosting: "",
    })).toThrow("`kv` must be a plain object.")
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
