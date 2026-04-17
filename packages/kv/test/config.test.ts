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
        base: ".data/kv",
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

  it("accepts legacy Upstash env var aliases", () => {
    expect(normalizeKVOptions(undefined, {
      env: {
        UPSTASH_REDIS_REST_TOKEN: "token",
        UPSTASH_REDIS_REST_URL: "https://upstash.example.com",
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

  it("rejects non-object config", () => {
    expect(() => normalizeKVOptions(true as never, {
      env: {},
      hosting: "",
    })).toThrow("`kv` must be a plain object.")
  })
})

describe("Cloudflare integration", () => {
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
})

describe("warnVercelKVFallback", () => {
  it("reports fs-lite on Vercel hosting", () => {
    const error = vi.fn()

    warnVercelKVFallback({
      logger: { error },
    }, normalizeKVOptions(undefined, {
      env: {},
      hosting: "vercel",
    }), "vercel")

    expect(error).toHaveBeenCalledWith(
      "Vercel hosting requires Upstash-backed KV. Set `KV_REST_API_URL` and `KV_REST_API_TOKEN`.",
    )
  })
})
