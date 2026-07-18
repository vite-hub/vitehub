import { describe, expect, it } from "vitest"

import { composeNitroCloudflareProviderOutput, registerCloudflareProviderOutput } from "../src/build/cloudflare-provider-output.ts"

describe("Cloudflare provider output", () => {
  it("composes current ViteHub resources into Nitro's Wrangler config by identity", () => {
    const config = {}
    registerCloudflareProviderOutput(config, "queue", {
      queues: { producers: [{ binding: "JOBS", queue: "jobs" }] },
    })
    registerCloudflareProviderOutput(config, "storage", {
      queues: {
        producers: [
          { binding: "JOBS", queue: "jobs" },
          { binding: "EMAILS", queue: "emails" },
        ],
      },
      r2Buckets: [{ binding: "BLOB", bucket_name: "assets" }],
      rateLimits: [{ name: "UPLOADS", namespace_id: "1", simple: { limit: 10, period: 60 } }],
    })

    expect(
      composeNitroCloudflareProviderOutput(config, {
        cloudflare: {
          wrangler: {
            compatibility_date: "2026-07-18",
            name: undefined,
            queues: { producers: [{ binding: "USER", queue: "user", delivery_delay: 1 }] },
            routes: ["example.com/*"],
          },
        },
      }),
    ).toEqual({
      cloudflare: {
        wrangler: {
          compatibility_date: "2026-07-18",
          queues: {
            producers: [
              { binding: "USER", queue: "user", delivery_delay: 1 },
              { binding: "JOBS", queue: "jobs" },
              { binding: "EMAILS", queue: "emails" },
            ],
          },
          r2_buckets: [{ binding: "BLOB", bucket_name: "assets" }],
          ratelimits: [{ name: "UPLOADS", namespace_id: "1", simple: { limit: 10, period: 60 } }],
          routes: ["example.com/*"],
        },
      },
    })
  })

  it("preserves compatible user resources and rejects conflicting identities", () => {
    const config = {}
    registerCloudflareProviderOutput(config, "queue", {
      queues: { producers: [{ binding: "JOBS", queue: "jobs" }] },
    })

    expect(
      composeNitroCloudflareProviderOutput(config, {
        cloudflare: {
          wrangler: {
            queues: { producers: [{ binding: "JOBS", queue: "jobs", delivery_delay: 1 }] },
          },
        },
      }),
    ).toHaveProperty("cloudflare.wrangler.queues.producers", [{ binding: "JOBS", queue: "jobs", delivery_delay: 1 }])
    expect(() =>
      composeNitroCloudflareProviderOutput(config, {
        cloudflare: { wrangler: { queues: { producers: [{ binding: "JOBS", queue: "other" }] } } },
      }),
    ).toThrow(/already assigned/)
  })

  it("replaces an owner's contribution without changing application policy", () => {
    const config = {}
    registerCloudflareProviderOutput(config, "queue", {
      queues: { consumers: [{ queue: "old" }] },
    })
    registerCloudflareProviderOutput(config, "queue", {
      queues: { consumers: [{ queue: "current" }] },
    })

    const output = composeNitroCloudflareProviderOutput(config, {
      cloudflare: { wrangler: { observability: { enabled: false } } },
    })
    expect(output).toHaveProperty("cloudflare.wrangler.queues.consumers", [{ queue: "current" }])
    expect(output).toHaveProperty("cloudflare.wrangler.observability.enabled", false)
    expect(output).not.toHaveProperty("cloudflare.wrangler.compatibility_date")
  })

  it("preserves non-plain Nitro config outside Wrangler composition", () => {
    const config = {}
    const external = /^node:/
    const buildBefore = () => undefined
    const hooks = { "build:before": buildBefore }
    const rollupConfig = { external }
    registerCloudflareProviderOutput(config, "queue", {
      queues: { producers: [{ binding: "JOBS", queue: "jobs" }] },
    })

    const output = composeNitroCloudflareProviderOutput(config, {
      cloudflare: { wrangler: { name: undefined } },
      hooks,
      rollupConfig,
    })

    expect(output.hooks).toBe(hooks)
    expect(output.rollupConfig).toBe(rollupConfig)
    expect(output).not.toHaveProperty("cloudflare.wrangler.name")
  })
})
