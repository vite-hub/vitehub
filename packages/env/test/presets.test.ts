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

  it("requires the TypeSafe API key", () => {
    vi.stubEnv("TYPESAFE_API_KEY", undefined)
    expect(() => resolveTypesafe(undefined, {})).toThrow("Required Env value is missing")
  })

  it("routes the Vercel provider through the AI Gateway key", () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", undefined)

    expect(resolveTypesafe({ provider: "vercel" }, {})).toEqual({ apiKey: undefined, model: "typesafe-ai/jev", provider: "vercel" })
    const typesafe = resolveTypesafe({ model: "typesafe-ai/jev-2", provider: "vercel" }, { AI_GATEWAY_API_KEY: "gateway-key" })
    expect(typesafe).toMatchObject({ model: "typesafe-ai/jev-2", provider: "vercel" })
    expect(typesafe).toHaveProperty("apiKey", expect.any(SecretEnv))
  })

  it("describes the declarations without values", () => {
    const registry = createRuntimeRegistry({ typesafe: typesafeEnv() })

    expect(describeServerEnv(registry).entries).toEqual([
      { path: "env.server.typesafe.apiKey", source: "env", secret: true, required: true, hasDefault: false, type: "string" },
      { path: "env.server.typesafe.model", source: "env", secret: false, required: true, hasDefault: true, type: "string" },
      { path: "env.server.typesafe.provider", source: "literal", secret: false, required: false, hasDefault: false },
    ])
  })
})
