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

  it.each(["00000000000000000000000000000000", "00000000-0000-4000-8000-000000000000"])("preserves unresolved KV preview id %s instead of falling back to production", (placeholder) => {
    const production = { binding: "KV", id: "production-id" }
    const preview = { ...production, preview_id: placeholder }
    for (const kv_namespaces of [[production, preview], [preview, production], [preview, preview], [preview]]) {
      const config = { kv_namespaces, env: { production: { kv_namespaces } } }
      const expected = [preview]
      expect(collapseWranglerConfig(config)).toEqual({ kv_namespaces: expected, env: { production: { kv_namespaces: expected } } })
    }
    const resolved = { ...production, preview_id: "preview-id" }
    for (const kv_namespaces of [[preview, resolved], [resolved, preview]]) {
      expect(collapseWranglerConfig({ kv_namespaces })).toEqual({ kv_namespaces: [resolved] })
    }
    expect(collapseWranglerConfig({ kv_namespaces: [{ ...preview, id: placeholder }] })).toEqual({
      kv_namespaces: [{ binding: "KV", preview_id: placeholder }],
    })
  })

  it.each(["00000000000000000000000000000000", "00000000-0000-4000-8000-000000000000"])("treats Hyperdrive id %s as a placeholder", (placeholder) => {
    for (const [generated, project] of [[placeholder, "hyperdrive-id"], ["hyperdrive-id", placeholder]]) {
      expect(collapseWranglerConfig({
        hyperdrive: [{ binding: "DATABASE", id: generated }, { binding: "DATABASE", id: project }],
      })).toEqual({ hyperdrive: [{ binding: "DATABASE", id: "hyperdrive-id" }] })
    }
    expect(collapseWranglerConfig({
      hyperdrive: [{ binding: "DATABASE", id: placeholder }, { binding: "DATABASE", id: placeholder }],
    })).toEqual({ hyperdrive: [{ binding: "DATABASE", id: placeholder }] })
    expect(collapseWranglerConfig({
      hyperdrive: [{ binding: "DATABASE", id: placeholder }],
    })).toEqual({ hyperdrive: [{ binding: "DATABASE", id: placeholder }] })
    expect(collapseWranglerConfig({
      env: { production: { hyperdrive: [{ binding: "DATABASE" }, { binding: "DATABASE", id: placeholder }] } },
    })).toEqual({ env: { production: { hyperdrive: [{ binding: "DATABASE", id: placeholder }] } } })
  })

  it("collapses containers by class name at the top level and in environments", () => {
    const generated = { class_name: "Sandbox", image: "./Dockerfile", instance_type: "lite", max_instances: 12 }
    const project = { ...generated, image_build_context: ".", name: "sandbox" }
    const other = { class_name: "Other", image: "./OtherDockerfile", max_instances: 1 }
    const containers = [generated, other, project, project]
    const expected = [project, other]
    const config = { containers, env: { production: { containers } } }
    expect(collapseWranglerConfig(config)).toEqual({ containers: expected, env: { production: { containers: expected } } })
    expect(config.containers).toEqual([generated, other, project, project])
  })

  it.each([
    { field: "image", value: "./OtherDockerfile" },
    { field: "image_build_context", value: "./other" },
    { field: "image_vars", value: { APP_ENV: "staging" } },
    { field: "name", value: "other-sandbox" },
    { field: "instance_type", value: "standard-1" },
    { field: "max_instances", value: 1 },
  ])("rejects conflicting container $field values", ({ field, value }) => {
    const generated = { class_name: "Sandbox", image: "./Dockerfile", image_build_context: ".", image_vars: { APP_ENV: "production" }, name: "sandbox", instance_type: "lite", max_instances: 12 }
    const project = { ...generated, [field]: value }
    for (const containers of [[generated, project], [project, generated]]) {
      expect(() => collapseWranglerConfig({ containers })).toThrow(expect.objectContaining({ code: "INTERNAL_B0051", message: expect.stringContaining(field) }))
    }
  })

  it("collapses name-linked containers without conflating names and class names", () => {
    const named = { name: "Sandbox", image: "./Dockerfile" }
    const project = { ...named, image_build_context: "." }
    const linked = { class_name: "Sandbox", image: "./OtherDockerfile" }
    const other = { name: "Other", image: "./Dockerfile" }
    const containers = [named, linked, other, project, linked, other]
    const expected = [project, linked, other]
    expect(collapseWranglerConfig({ containers, env: { production: { containers } } })).toEqual({
      containers: expected, env: { production: { containers: expected } },
    })
  })

  it("reconciles Container aliases even when the linking entry comes last", () => {
    const byClass = { class_name: "Sandbox", image: "./Dockerfile" }
    const byName = { name: "sandbox", image_build_context: "." }
    const bridge = { class_name: "Sandbox", name: "sandbox" }
    const otherName = { name: "Sandbox", image: "./OtherDockerfile" }
    const otherClass = { class_name: "sandbox", image: "./OtherDockerfile" }
    for (const entries of [[byClass, byName, bridge], [byName, byClass, bridge], [bridge, byClass, byName], [bridge, byName, byClass], [byClass, bridge, byName], [byName, bridge, byClass]]) {
      const containers = [entries[0], otherName, otherClass, ...entries.slice(1)]
      const expected = [{ ...byClass, ...byName }, otherName, otherClass]
      const config = { containers, env: { production: { containers } } }
      const before = structuredClone(config)
      expect(collapseWranglerConfig(config)).toEqual({ containers: expected, env: { production: { containers: expected } } })
      expect(config).toEqual(before)
    }
  })

  it("keeps generated field precedence when a later Container links earlier entries", () => {
    const byClass = { class_name: "Sandbox" }
    const byName = { name: "sandbox", ssh: { enabled: true } }
    const later = { class_name: "Sandbox", ssh: { enabled: false } }
    const bridge = { class_name: "Sandbox", name: "sandbox" }
    expect(collapseWranglerConfig({ containers: [byClass, byName, later, bridge] })).toEqual({
      containers: [{ ...bridge, ssh: { enabled: true } }],
    })
  })

  it("rejects conflicting Container resources linked by either alias", () => {
    const bridge = { class_name: "Sandbox", name: "sandbox", image: "./Dockerfile" }
    for (const project of [{ name: "sandbox", image: "./OtherDockerfile" }, { ...bridge, class_name: "Other" }]) {
      for (const containers of [[bridge, project], [project, bridge]]) {
        expect(() => collapseWranglerConfig({ containers })).toThrow(expect.objectContaining({ code: "INTERNAL_B0051" }))
      }
    }
  })

  it.each(["class_name", "name"])("rejects container scheduling-policy changes when linked by %s", (field) => {
    const identity = { [field]: "Sandbox" }
    const managed = { ...identity, scheduling_policy: "durable_object", images: { base: { dockerfile: "./Dockerfile" } } }
    for (const scheduling_policy of [undefined, "default"]) {
      const generated = { ...identity, scheduling_policy, image: "./Dockerfile", instance_type: "lite" }
      for (const containers of [[generated, managed], [managed, generated]]) {
        for (const config of [{ containers }, { env: { production: { containers } } }]) {
          expect(() => collapseWranglerConfig(config)).toThrow(expect.objectContaining({ code: "INTERNAL_B0051", message: expect.stringContaining("scheduling_policy") }))
        }
      }
    }
  })

  it("merges compatible container policies and rejects conflicting named images", () => {
    const generated = { class_name: "Sandbox", image: "./Dockerfile" }
    const project = { ...generated, scheduling_policy: "default", image_vars: { APP_ENV: "production" } }
    for (const containers of [[generated, project], [project, generated]]) {
      expect(collapseWranglerConfig({ containers })).toEqual({ containers: [project] })
    }

    const managed = { name: "sandbox", scheduling_policy: "durable_object", images: { base: { dockerfile: "./Dockerfile" } } }
    const configured = { ...managed, ssh: { enabled: true } }
    expect(collapseWranglerConfig({ containers: [managed, configured, managed] })).toEqual({ containers: [configured] })
    const other = { ...managed, images: { base: { dockerfile: "./OtherDockerfile" } } }
    for (const containers of [[managed, other], [other, managed]]) {
      expect(() => collapseWranglerConfig({ containers })).toThrow(expect.objectContaining({ code: "INTERNAL_B0051", message: expect.stringContaining("images") }))
    }
  })

  it("rejects combining single and named container images in either order", () => {
    const named = { class_name: "Sandbox", scheduling_policy: "durable_object", images: { base: { dockerfile: "./Dockerfile" } } }
    const single = { class_name: "Sandbox", scheduling_policy: "durable_object", image: "./Dockerfile" }
    for (const containers of [[single, named], [named, single]]) {
      expect(() => collapseWranglerConfig({ containers })).toThrow(expect.objectContaining({ code: "INTERNAL_B0051", message: expect.stringContaining("image / images") }))
    }
  })

  it("checks service environments while preserving compatible duplicates", () => {
    const generated = { binding: "API", service: "api" }
    const production = { ...generated, environment: "production" }
    const staging = { ...generated, environment: "staging" }
    expect(collapseWranglerConfig({ services: [generated, production, production] })).toEqual({ services: [production] })
    for (const services of [[production, staging], [staging, production]]) {
      for (const config of [{ services }, { env: { production: { services } } }]) {
        expect(() => collapseWranglerConfig(config)).toThrow(expect.objectContaining({ code: "INTERNAL_B0051", message: expect.stringContaining("environment") }))
      }
    }
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

  it.each([
    { field: "environment", config: { durable_objects: { bindings: [{ name: "ROOM", class_name: "Room", script_name: "rooms", environment: "production" }, { name: "ROOM", class_name: "Room", script_name: "rooms", environment: "staging" }] } } },
    { field: "transferred_classes", config: { migrations: [{ tag: "v1", transferred_classes: [{ from: "OldRoom", from_script: "rooms", to: "Room" }] }, { tag: "v1", transferred_classes: [{ from: "OtherRoom", from_script: "rooms", to: "Room" }] }] } },
    { field: "jurisdiction", config: { workflows: [{ binding: "TASKS", name: "tasks", class_name: "Tasks", jurisdiction: "eu" }, { binding: "TASKS", name: "tasks", class_name: "Tasks", jurisdiction: "us" }] } },
    { field: "allowed_destination_addresses", config: { send_email: [{ name: "EMAIL", allowed_destination_addresses: ["first@example.com"] }, { name: "EMAIL", allowed_destination_addresses: ["second@example.com"] }] } },
    { field: "allowed_sender_addresses", config: { send_email: [{ name: "EMAIL", allowed_sender_addresses: ["first@example.com"] }, { name: "EMAIL", allowed_sender_addresses: ["second@example.com"] }] } },
  ])("rejects conflicting $field resource values", ({ config, field }) => {
    expect(() => collapseWranglerConfig(config)).toThrow(expect.objectContaining({ code: "INTERNAL_B0051", message: expect.stringContaining(field) }))
  })

  it("fills missing resource fields and collapses identical resource policies", () => {
    const room = { name: "ROOM", class_name: "Room", script_name: "rooms", environment: "production" }
    const migration = { tag: "v1", transferred_classes: [{ from: "OldRoom", from_script: "rooms", to: "Room" }] }
    const workflow = { binding: "TASKS", name: "tasks", class_name: "Tasks", jurisdiction: "eu" }
    const email = { name: "EMAIL", allowed_destination_addresses: ["recipient@example.com"], allowed_sender_addresses: ["sender@example.com"] }
    expect(collapseWranglerConfig({
      durable_objects: { bindings: [{ name: "ROOM", class_name: "Room" }, room, room] },
      migrations: [{ tag: "v1" }, migration, migration],
      workflows: [{ binding: "TASKS", name: "tasks", class_name: "Tasks" }, workflow, workflow],
      send_email: [{ name: "EMAIL", allowed_sender_addresses: ["sender@example.com"] }, email, email],
    })).toEqual({
      durable_objects: { bindings: [room] },
      migrations: [migration],
      workflows: [workflow],
      send_email: [email],
    })
  })

  it("rejects mutually exclusive email destination restrictions in either order", () => {
    const address = { name: "EMAIL", destination_address: "recipient@example.com" }
    const allowlist = { name: "EMAIL", allowed_destination_addresses: ["recipient@example.com"] }
    for (const entries of [[address, allowlist], [allowlist, address]]) {
      expect(() => collapseWranglerConfig({ send_email: entries })).toThrow(expect.objectContaining({ code: "INTERNAL_B0051" }))
    }
    expect(collapseWranglerConfig({
      send_email: [address, { name: "EMAIL", allowed_sender_addresses: ["sender@example.com"] }, address],
    })).toEqual({ send_email: [{ ...address, allowed_sender_addresses: ["sender@example.com"] }] })
  })

  it("rejects combining an external Workflow with a local jurisdiction in either order", () => {
    const external = { binding: "TASKS", name: "tasks", class_name: "Tasks", script_name: "external-worker" }
    const local = { binding: "TASKS", name: "tasks", class_name: "Tasks", jurisdiction: "eu" }
    for (const entries of [[external, local], [local, external]]) {
      expect(() => collapseWranglerConfig({ workflows: entries })).toThrow(expect.objectContaining({ code: "INTERNAL_B0051" }))
    }
  })

  it("recognizes all-zero ids only", () => {
    expect(["00000000000000000000000000000000", "00000000-0000-0000-0000-000000000000", "00000000-0000-4000-8000-000000000000"].every(isPlaceholderCloudflareId)).toBe(true)
    expect(["", "0f00000000000000000000000000000a", "00000000-0000-4000-8000-000000000001", 0].some(isPlaceholderCloudflareId)).toBe(false)
  })
})
