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

    const output = composeNitroCloudflareProviderOutput(config, {
      cloudflare: {
        wrangler: {
          compatibility_date: "2026-07-18",
          name: undefined,
          queues: { producers: [{ binding: "USER", queue: "user", delivery_delay: 1 }] },
          routes: ["example.com/*"],
        },
      },
    })
    expect(output.cloudflare).toEqual({
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

  it("composes required secrets without taking ownership of existing names", () => {
    const config = {}
    registerCloudflareProviderOutput(config, "env", {
      requiredSecrets: ["EXISTING_SECRET", "VITEHUB_TOKEN"],
    })

    const first = composeNitroCloudflareProviderOutput(config, {
      cloudflare: {
        wrangler: {
          secrets: { required: ["EXISTING_SECRET"] },
        },
      },
    })
    expect(first).toHaveProperty("cloudflare.wrangler.secrets.required", ["EXISTING_SECRET", "VITEHUB_TOKEN"])

    registerCloudflareProviderOutput(config, "env", {})
    expect(composeNitroCloudflareProviderOutput(config, first)).toHaveProperty(
      "cloudflare.wrangler.secrets.required",
      ["EXISTING_SECRET"],
    )
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

  it("removes an owner's previously composed entries when recomposing", () => {
    const config = {}
    registerCloudflareProviderOutput(config, "queue", { queues: { producers: [{ binding: "OLD", queue: "old" }] } })
    const first = composeNitroCloudflareProviderOutput(config, { cloudflare: { wrangler: {} } })
    registerCloudflareProviderOutput(config, "queue", { queues: { producers: [{ binding: "NEW", queue: "new" }] } })

    const second = composeNitroCloudflareProviderOutput(config, first)
    expect(second).toHaveProperty(
      "cloudflare.wrangler.queues.producers",
      [{ binding: "NEW", queue: "new" }],
    )
    registerCloudflareProviderOutput(config, "queue", {})
    expect(composeNitroCloudflareProviderOutput(config, second)).not.toHaveProperty("cloudflare.wrangler.queues")
  })

  it("carries applied ownership through copied Nitro configs", () => {
    const firstConfig = {}
    registerCloudflareProviderOutput(firstConfig, "queue", {
      queues: { producers: [{ binding: "OLD", queue: "old" }] },
    })
    const first = composeNitroCloudflareProviderOutput(firstConfig, {})
    const copied = { ...first, cloudflare: { ...(first.cloudflare as object) } }
    const finalConfig = {}
    registerCloudflareProviderOutput(finalConfig, "queue", {})

    expect(composeNitroCloudflareProviderOutput(finalConfig, copied)).not.toHaveProperty("cloudflare.wrangler.queues")
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
