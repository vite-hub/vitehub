import { describe, expect, it } from "vitest"
import { env } from "../src/core/declarations.ts"
import { createRuntimeRegistry } from "../src/core/resolve.ts"
import { describeServerEnv } from "../src/server.ts"
import { cloudflareRequest } from "./cloudflare-request.ts"

describe("Server Env declaration inventory", () => {
  it("reserves the deployment host selector from canonical application names", () => {
    const error = expect.objectContaining({
      code: "ENV_DECLARATION_INVALID",
      cause: expect.objectContaining({ message: expect.stringContaining("VITEHUB_HOST is reserved for deployment host selection") }),
    })
    expect(() => createRuntimeRegistry({ host: env() })).toThrow(error)
    expect(() => createRuntimeRegistry({ host: env({ source: env.source("APP_HOST") }) })).toThrow(error)
    const registry = createRuntimeRegistry({ host: env({ source: env.source("APP_HOST", { canonical: false }) }) })
    expect(registry.host).toMatchObject({ source: { name: "APP_HOST", canonical: false } })
    expect(describeServerEnv(registry).entries[0]).not.toHaveProperty("canonicalName")
    const prefixed = createRuntimeRegistry({ host: env() }, { prefix: "APP_" })
    expect(describeServerEnv(prefixed).entries[0]).toMatchObject({ canonicalName: "APP_HOST" })
  })

  it("describes host, provider and literal declarations without exposing their values or storage keys", () => {
    const registry = createRuntimeRegistry({
      host: env({ secret: true, source: env.source("PRIVATE_HOST_NAME", { canonical: false }), default: "private-default" }),
      nested: { token: env({ secret: true, source: env.provider("vault", "private/storage/path") }) },
      label: "private-literal",
      optional: env({ optional: true }),
    })
    const description = describeServerEnv(registry)
    expect(description.entries).toEqual([
      { path: "env.server.host", source: "env", secret: true, required: true, hasDefault: true, type: "string" },
      { path: "env.server.nested.token", source: "provider", provider: "vault", secret: true, required: true, hasDefault: false, type: "string" },
      { path: "env.server.label", source: "literal", secret: false, required: false, hasDefault: false },
      { path: "env.server.optional", canonicalName: "VITEHUB_OPTIONAL", source: "env", secret: false, required: false, hasDefault: false, type: "string" },
    ])
    const serialized = JSON.stringify(description)
    for (const value of ["PRIVATE_HOST_NAME", "private-default", "private/storage/path", "private-literal"]) expect(serialized).not.toContain(value)
  })

  it("returns independent metadata and withholds unsafe declaration names ", () => {
    const registry = createRuntimeRegistry({ "secret in name!": env({ source: env.provider("vault", "key") }) })
    expect(describeServerEnv(registry).entries).toEqual([{ source: "provider", provider: "vault", secret: false, required: true, hasDefault: false, type: "string" }])
    expect(describeServerEnv({})).toEqual({ entries: [] })
  })

  it("uses the same paths for inventory and status inspection", async () => {
    const { inspectServerEnv } = await import("../src/server.ts")
    const registry = createRuntimeRegistry({
      nested: { token: env({ source: env.source("NESTED_TOKEN") }) },
      "nested.token": env({ source: env.source("DOTTED_TOKEN") }),
    })
    const inspection = await inspectServerEnv(registry, cloudflareRequest({ DOTTED_TOKEN: "dotted" }))
    expect(inspection.entries.map(entry => entry.path)).toEqual(describeServerEnv(registry).entries.map(entry => entry.path))
    // A dotted declaration key must not report its status under the nested path.
    expect(inspection.entries).toEqual([
      { masked: false, path: "env.server.nested.token", required: true, source: "env", status: "missing" },
      { masked: false, required: true, source: "env", status: "available" },
    ])
  })

  it("reports which kind of name supplied a value and flags conflicting names", async () => {
    const { inspectServerEnv } = await import("../src/server.ts")
    const registry = createRuntimeRegistry({
      apiKey: env({ secret: true, source: env.source("VENDOR_API_KEY") }),
      region: env(),
      url: env(),
    })
    const inspection = await inspectServerEnv(registry, cloudflareRequest({ VITEHUB_API_KEY: "canonical-secret", VENDOR_API_KEY: "vendor-secret", VITEHUB_REGION: "eu", REGION: "eu", URL: "https://example.test" }))
    expect(inspection.entries).toEqual([
      { masked: true, path: "env.server.apiKey", required: true, source: "env", status: "available", via: "canonical", conflict: true },
      { masked: false, path: "env.server.region", required: true, source: "env", status: "available", via: "canonical" },
      { masked: false, path: "env.server.url", required: true, source: "env", status: "available", via: "conventional" },
    ])
    expect(JSON.stringify(inspection)).not.toContain("secret")
  })

  it("omits origin metadata when canonical lookup is disabled", async () => {
    const { inspectServerEnv } = await import("../src/server.ts")
    const registry = createRuntimeRegistry({
      channel: env({ source: env.source("CHANNEL_TOKEN", { canonical: false }) }),
    })
    const inspection = await inspectServerEnv(registry, cloudflareRequest({ CHANNEL_TOKEN: "token" }))
    expect(inspection.entries).toEqual([
      { masked: false, path: "env.server.channel", required: true, source: "env", status: "available" },
    ])
  })
})
