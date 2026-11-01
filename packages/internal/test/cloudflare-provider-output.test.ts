import { describe, expect, it, vi } from "vitest"

import { collapseWranglerConfig, isPlaceholderCloudflareId } from "../src/build/cloudflare.ts"
import { composeNitroCloudflareProviderOutput } from "../src/build/cloudflare-provider-output.ts"
import { contributeCloudflareProviderOutput, createProviderOutputCatalog } from "../src/build/provider-output-catalog.ts"

describe("Cloudflare provider output", () => {
  it("composes current ViteHub resources into Nitro's Wrangler config by identity", () => {
    const config = createProviderOutputCatalog()
    contributeCloudflareProviderOutput(config, { owner: "queue",
      queues: { producers: [{ binding: "JOBS", queue: "jobs" }] },
    })
    contributeCloudflareProviderOutput(config, { owner: "blob",
      r2Buckets: [{ binding: "BLOB", bucket_name: "assets" }],
    })
    contributeCloudflareProviderOutput(config, { owner: "rate-limit",
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
          ],
        },
        r2_buckets: [{ binding: "BLOB", bucket_name: "assets" }],
        ratelimits: [{ name: "UPLOADS", namespace_id: "1", simple: { limit: 10, period: 60 } }],
        routes: ["example.com/*"],
      },
    })
  })

  it("preserves compatible user resources and rejects conflicting identities", () => {
    const config = createProviderOutputCatalog()
    contributeCloudflareProviderOutput(config, { owner: "queue",
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

  it("treats an R2 binding in another jurisdiction as a different bucket", () => {
    const config = createProviderOutputCatalog()
    contributeCloudflareProviderOutput(config, { owner: "blob",
      r2Buckets: [{ binding: "BLOB", bucket_name: "assets", jurisdiction: "eu" }],
    })
    const withBuckets = (r2_buckets: unknown[]) => ({ cloudflare: { wrangler: { r2_buckets } } })

    expect(composeNitroCloudflareProviderOutput(config, withBuckets([{ binding: "BLOB", bucket_name: "assets", jurisdiction: "eu", preview_bucket_name: "preview" }])))
      .toHaveProperty("cloudflare.wrangler.r2_buckets", [{ binding: "BLOB", bucket_name: "assets", jurisdiction: "eu", preview_bucket_name: "preview" }])
    expect(() => composeNitroCloudflareProviderOutput(config, withBuckets([{ binding: "BLOB", bucket_name: "assets" }])))
      .toThrow(/already assigned/)
    expect(() => composeNitroCloudflareProviderOutput(config, withBuckets([{ binding: "BLOB", bucket_name: "assets", jurisdiction: "fedramp" }])))
      .toThrow(/already assigned/)
  })

  it("composes required secrets without taking ownership of existing names", () => {
    const config = createProviderOutputCatalog()
    contributeCloudflareProviderOutput(config, { owner: "env",
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

    contributeCloudflareProviderOutput(config, { owner: "env" })
    expect(composeNitroCloudflareProviderOutput(config, first)).toHaveProperty(
      "cloudflare.wrangler.secrets.required",
      ["EXISTING_SECRET"],
    )
  })

  it("composes and removes required secrets independently in named environments", () => {
    const config = createProviderOutputCatalog()
    contributeCloudflareProviderOutput(config, { owner: "env",
      requiredSecrets: ["EXISTING_SECRET", "VITEHUB_TOKEN"],
    })

    const first = composeNitroCloudflareProviderOutput(config, {
      cloudflare: {
        wrangler: {
          secrets: { required: ["EXISTING_SECRET"] },
          env: {
            staging: { secrets: { required: ["VITEHUB_TOKEN"] } },
            production: { name: "production-worker" },
          },
        },
      },
    })
    expect(first).toHaveProperty("cloudflare.wrangler.env.staging.secrets.required", ["VITEHUB_TOKEN", "EXISTING_SECRET"])
    expect(first).toHaveProperty("cloudflare.wrangler.env.production.secrets.required", ["EXISTING_SECRET", "VITEHUB_TOKEN"])

    contributeCloudflareProviderOutput(config, { owner: "env" })
    const second = composeNitroCloudflareProviderOutput(config, first)
    expect(second).toHaveProperty("cloudflare.wrangler.secrets.required", ["EXISTING_SECRET"])
    expect(second).toHaveProperty("cloudflare.wrangler.env.staging.secrets.required", ["VITEHUB_TOKEN"])
    expect(second).not.toHaveProperty("cloudflare.wrangler.env.production.secrets")
    expect(second).toHaveProperty("cloudflare.wrangler.env.production.name", "production-worker")

    const removalConfig = createProviderOutputCatalog()
    contributeCloudflareProviderOutput(removalConfig, { owner: "env", requiredSecrets: ["VITEHUB_TOKEN"] })
    const withEnvironment = composeNitroCloudflareProviderOutput(removalConfig, {
      cloudflare: { wrangler: { env: { staging: { name: "staging-worker" } } } },
    })
    const withEnvironmentCloudflare = withEnvironment.cloudflare as { wrangler: Record<string, unknown> }
    const { env: _env, ...wranglerWithoutEnvironments } = withEnvironmentCloudflare.wrangler
    const withoutEnvironments = composeNitroCloudflareProviderOutput(removalConfig, {
      ...withEnvironment,
      cloudflare: { ...withEnvironmentCloudflare, wrangler: wranglerWithoutEnvironments },
    })
    expect(withoutEnvironments).not.toHaveProperty("cloudflare.wrangler.env")
  })

  it("does not recreate removed prototype-named environments", () => {
    const config = createProviderOutputCatalog()
    contributeCloudflareProviderOutput(config, { owner: "env", requiredSecrets: ["VITEHUB_TOKEN"] })

    const first = composeNitroCloudflareProviderOutput(config, {
      cloudflare: { wrangler: { env: { ["toString"]: { name: "prototype-worker" } } } },
    })
    expect(first).toHaveProperty("cloudflare.wrangler.env.toString.secrets.required", ["VITEHUB_TOKEN"])

    contributeCloudflareProviderOutput(config, { owner: "env" })
    const second = composeNitroCloudflareProviderOutput(config, { cloudflare: { wrangler: {} } })

    expect(second).not.toHaveProperty("cloudflare.wrangler.env.toString")
  })

  it("replaces an owner's contribution without changing application policy", () => {
    const config = createProviderOutputCatalog()
    contributeCloudflareProviderOutput(config, { owner: "queue",
      queues: { consumers: [{ queue: "old" }] },
    })
    contributeCloudflareProviderOutput(config, { owner: "queue",
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
    const config = createProviderOutputCatalog()
    contributeCloudflareProviderOutput(config, { owner: "queue", queues: { producers: [{ binding: "OLD", queue: "old" }] } })
    const first = composeNitroCloudflareProviderOutput(config, { cloudflare: { wrangler: {} } })
    contributeCloudflareProviderOutput(config, { owner: "queue", queues: { producers: [{ binding: "NEW", queue: "new" }] } })

    const second = composeNitroCloudflareProviderOutput(config, first)
    expect(second).toHaveProperty(
      "cloudflare.wrangler.queues.producers",
      [{ binding: "NEW", queue: "new" }],
    )
    contributeCloudflareProviderOutput(config, { owner: "queue" })
    expect(composeNitroCloudflareProviderOutput(config, second)).not.toHaveProperty("cloudflare.wrangler.queues")
  })

  it("carries applied ownership through copied Nitro configs", () => {
    const firstConfig = createProviderOutputCatalog()
    contributeCloudflareProviderOutput(firstConfig, { owner: "queue",
      queues: { producers: [{ binding: "OLD", queue: "old" }] },
    })
    const first = composeNitroCloudflareProviderOutput(firstConfig, {})
    const copied = { ...first, cloudflare: { ...(first.cloudflare as object) } }
    const finalConfig = createProviderOutputCatalog()
    contributeCloudflareProviderOutput(finalConfig, { owner: "queue" })

    expect(composeNitroCloudflareProviderOutput(finalConfig, copied)).not.toHaveProperty("cloudflare.wrangler.queues")
  })

  it("shares applied ownership across bundled Internal copies", async () => {
    vi.resetModules()
    const firstOutput = await import("../src/build/cloudflare-provider-output.ts")
    const firstCatalog = await import("../src/build/provider-output-catalog.ts")
    const initialCatalog = firstCatalog.createProviderOutputCatalog()
    firstCatalog.contributeCloudflareProviderOutput(initialCatalog, { owner: "queue",
      queues: { producers: [{ binding: "OLD", queue: "old" }] },
    })
    const initial = firstOutput.composeNitroCloudflareProviderOutput(initialCatalog, {})

    vi.resetModules()
    const finalOutput = await import("../src/build/cloudflare-provider-output.ts")
    const finalCatalog = await import("../src/build/provider-output-catalog.ts")
    const replacementCatalog = finalCatalog.createProviderOutputCatalog()
    finalCatalog.contributeCloudflareProviderOutput(replacementCatalog, { owner: "queue",
      queues: { producers: [{ binding: "NEW", queue: "new" }] },
    })

    expect(finalOutput.composeNitroCloudflareProviderOutput(replacementCatalog, initial)).toHaveProperty(
      "cloudflare.wrangler.queues.producers",
      [{ binding: "NEW", queue: "new" }],
    )
  })

  it("preserves non-plain Nitro config outside Wrangler composition", () => {
    const config = createProviderOutputCatalog()
    const external = /^node:/
    const buildBefore = () => undefined
    const hooks = { "build:before": buildBefore }
    const rollupConfig = { external }
    contributeCloudflareProviderOutput(config, { owner: "queue",
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

describe("collapseWranglerConfig", () => {
  // Nitro's Cloudflare preset writes the generated arrays first and the project's wrangler config after them.
  it("keeps one entry per binding, with the project's real ids over missing or all-zero ones", () => {
    expect(collapseWranglerConfig({
      compatibility_flags: ["nodejs_compat", "nodejs_als", "nodejs_compat"],
      kv_namespaces: [{ binding: "KV" }, { binding: "SESSIONS", id: "00000000000000000000000000000000" }, { binding: "KV", id: "kv-id" }, { binding: "SESSIONS", id: "sessions-id" }],
      r2_buckets: [{ binding: "BLOB", bucket_name: "assets" }, { binding: "BLOB", bucket_name: "assets", jurisdiction: "eu" }],
      ratelimits: [{ name: "UPLOADS", namespace_id: "1", simple: { limit: 10, period: 60 } }, { name: "UPLOADS", namespace_id: "1", simple: { limit: 10, period: 60 } }],
      durable_objects: { bindings: [{ class_name: "Room", name: "ROOM" }, { class_name: "Room", name: "ROOM" }] },
      migrations: [{ new_sqlite_classes: ["Room"], tag: "v1" }, { new_sqlite_classes: ["Room"], tag: "v1" }],
      queues: { producers: [{ binding: "JOBS", queue: "jobs" }, { binding: "JOBS", queue: "jobs" }] },
      secrets: { required: ["TOKEN", "OTHER", "TOKEN"] },
    })).toEqual({
      compatibility_flags: ["nodejs_compat", "nodejs_als"],
      kv_namespaces: [{ binding: "KV", id: "kv-id" }, { binding: "SESSIONS", id: "sessions-id" }],
      r2_buckets: [{ binding: "BLOB", bucket_name: "assets", jurisdiction: "eu" }],
      ratelimits: [{ name: "UPLOADS", namespace_id: "1", simple: { limit: 10, period: 60 } }],
      durable_objects: { bindings: [{ class_name: "Room", name: "ROOM" }] },
      migrations: [{ new_sqlite_classes: ["Room"], tag: "v1" }],
      queues: { producers: [{ binding: "JOBS", queue: "jobs" }] },
      secrets: { required: ["TOKEN", "OTHER"] },
    })
  })

  it("leaves out an id that stays all-zero, so Wrangler provisions the resource", () => {
    expect(collapseWranglerConfig({
      kv_namespaces: [{ binding: "KV" }, { binding: "KV", id: "00000000000000000000000000000000" }],
    })).toEqual({ kv_namespaces: [{ binding: "KV" }] })
  })

  it("collapses each Wrangler environment", () => {
    expect(collapseWranglerConfig({
      env: { production: { kv_namespaces: [{ binding: "KV" }, { binding: "KV", id: "production-id" }], secrets: { required: ["TOKEN", "TOKEN"] } } },
    })).toEqual({
      env: { production: { kv_namespaces: [{ binding: "KV", id: "production-id" }], secrets: { required: ["TOKEN"] } } },
    })
  })

  it("fails when two entries of one name select different resources", () => {
    expect(() => collapseWranglerConfig({
      r2_buckets: [{ binding: "BLOB", bucket_name: "assets" }, { binding: "BLOB", bucket_name: "other" }],
    })).toThrow(expect.objectContaining({ code: "INTERNAL_B0051", message: expect.stringContaining("bucket_name") }))
    expect(() => collapseWranglerConfig({
      env: { production: { kv_namespaces: [{ binding: "KV", id: "a" }, { binding: "KV", id: "b" }] } },
    })).toThrow(expect.objectContaining({ message: expect.stringContaining("in env.production") }))
  })

  it("recognizes all-zero ids only", () => {
    expect(["00000000000000000000000000000000", "00000000-0000-0000-0000-000000000000", "00000000-0000-4000-8000-000000000000"].every(isPlaceholderCloudflareId)).toBe(true)
    expect(["", "0f00000000000000000000000000000a", "00000000-0000-4000-8000-000000000001", 0].some(isPlaceholderCloudflareId)).toBe(false)
  })
})
