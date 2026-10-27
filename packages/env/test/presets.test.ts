import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveServerEnv, SecretEnv, typesafeEnv } from "../src/index.ts"
import { createRuntimeRegistry } from "../src/core/resolve.ts"
import { describeServerEnv } from "../src/server.ts"

function resolveTypesafe(options: Parameters<typeof typesafeEnv>[0], env: Record<string, string>) {
  return resolveServerEnv(createRuntimeRegistry({ typesafe: typesafeEnv(options) }), { env }).typesafe
}

describe("typesafeEnv()", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("reads the TypeSafe API key and model", () => {
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", undefined)
    const typesafe = resolveTypesafe(undefined, { TYPESAFE_API_KEY: "ts-key" })

    expect(typesafe).toMatchObject({ model: "jev-latest", provider: "typesafe" })
    expect(typesafe).toHaveProperty("apiKey", expect.any(SecretEnv))
    expect(resolveTypesafe({ model: "jev-2" }, { TYPESAFE_API_KEY: "ts-key", TYPESAFE_DEFAULT_MODEL: "jev-3" }))
      .toMatchObject({ model: "jev-3" })
  })

  it("leaves a missing TypeSafe API key for the ask Driver to diagnose", () => {
    vi.stubEnv("TYPESAFE_API_KEY", undefined)
    expect(resolveTypesafe(undefined, {})).toMatchObject({ apiKey: undefined, provider: "typesafe" })
  })

  it("routes the Vercel provider through the AI Gateway key", () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", undefined)

    expect(resolveTypesafe({ provider: "vercel" }, {})).toEqual({ apiKey: undefined, model: "typesafe-ai/jev", provider: "vercel" })
    const typesafe = resolveTypesafe({ model: "typesafe-ai/jev-2", provider: "vercel" }, { AI_GATEWAY_API_KEY: "gateway-key" })
    expect(typesafe).toMatchObject({ model: "typesafe-ai/jev-2", provider: "vercel" })
    expect(typesafe).toHaveProperty("apiKey", expect.any(SecretEnv))
  })

  it("routes the Cloudflare provider through an AI Gateway custom provider", () => {
    for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_GATEWAY_ID", "CLOUDFLARE_AI_GATEWAY_SLUG", "CLOUDFLARE_AI_GATEWAY_TOKEN", "TYPESAFE_API_KEY", "TYPESAFE_DEFAULT_MODEL"]) vi.stubEnv(name, undefined)

    expect(resolveTypesafe({ provider: "cloudflare" }, {})).toEqual({
      apiKey: undefined,
      cloudflare: { accountId: undefined, gatewayId: undefined, slug: "typesafe", token: undefined },
      model: "jev-latest",
      provider: "cloudflare",
    })
    const typesafe = resolveTypesafe({ provider: "cloudflare" }, {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_AI_GATEWAY_ID: "finance",
      CLOUDFLARE_AI_GATEWAY_SLUG: "jev",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "cf-token",
      TYPESAFE_API_KEY: "ts-key",
    })
    expect(typesafe).toMatchObject({ cloudflare: { accountId: "account", gatewayId: "finance", slug: "jev" }, model: "jev-latest", provider: "cloudflare" })
    expect(typesafe).toHaveProperty("apiKey", expect.any(SecretEnv))
    expect(typesafe).toHaveProperty("cloudflare.token", expect.any(SecretEnv))
  })

  it("describes the declarations without values", () => {
    const registry = createRuntimeRegistry({ typesafe: typesafeEnv() })

    expect(describeServerEnv(registry).entries).toEqual([
      { path: "env.server.typesafe.apiKey", canonicalName: "VITEHUB_TYPESAFE_API_KEY", source: "env", secret: true, required: false, hasDefault: false, type: "string" },
      { path: "env.server.typesafe.model", canonicalName: "VITEHUB_TYPESAFE_MODEL", source: "env", secret: false, required: true, hasDefault: true, type: "string" },
      { path: "env.server.typesafe.provider", source: "literal", secret: false, required: false, hasDefault: false },
    ])
  })

  it("describes the Cloudflare declarations without values", () => {
    const registry = createRuntimeRegistry({ typesafe: typesafeEnv({ provider: "cloudflare" }) })

    expect(describeServerEnv(registry).entries.map(entry => [entry.path, entry.secret, entry.required])).toEqual([
      ["env.server.typesafe.apiKey", true, false],
      ["env.server.typesafe.cloudflare.accountId", false, false],
      ["env.server.typesafe.cloudflare.gatewayId", false, false],
      ["env.server.typesafe.cloudflare.slug", false, true],
      ["env.server.typesafe.cloudflare.token", true, false],
      ["env.server.typesafe.model", false, true],
      ["env.server.typesafe.provider", false, false],
    ])
  })
})
