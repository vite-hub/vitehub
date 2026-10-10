import { describe, expect, it } from "vitest"

import { env } from "../src/core/declarations.ts"
import { createRuntimeRegistry } from "../src/core/resolve.ts"
import { defineEnvProvider } from "../src/provider.ts"
import { SecretEnv } from "../src/secret.ts"
import { describeServerEnv, inspectServerEnv, loadServerEnv, resolveServerEnv } from "../src/server.ts"

function labellerRegistry() {
  return createRuntimeRegistry({
    labeller: {
      dryRun: env.boolean({ default: true }),
      minConfidence: env.number({ default: 0.6 }),
      mode: env.enum(["draft", "send"], { default: "draft" }),
      retries: env.number({ optional: true }),
      pin: env.number({ secret: true, source: env.source("LABELLER_PIN") }),
    },
  })
}

function capture(operation: () => unknown): unknown {
  try {
    operation()
  }
  catch (error) {
    return error
  }
  throw new Error("Expected operation to throw")
}

describe("typed Server Env values", () => {
  it("parses host values and uses typed defaults", () => {
    const registry = labellerRegistry()
    expect(resolveServerEnv(registry, { env: { LABELLER_PIN: "1234" } })).toMatchObject({
      labeller: { dryRun: true, minConfidence: 0.6, mode: "draft", retries: undefined },
    })

    const values = resolveServerEnv<{ labeller: { dryRun: boolean, minConfidence: number, mode: string, pin: SecretEnv<number>, retries?: number } }>(registry, {
      env: {
        LABELLER_DRY_RUN: "false",
        LABELLER_MIN_CONFIDENCE: " 0.8 ",
        LABELLER_MODE: "send",
        LABELLER_PIN: "1234",
        LABELLER_RETRIES: "3",
      },
    })
    expect(values.labeller).toMatchObject({ dryRun: false, minConfidence: 0.8, mode: "send", retries: 3 })
    expect(values.labeller.pin).toBeInstanceOf(SecretEnv)
    expect(String(values.labeller.pin)).toBe("<redacted>")
    expect(values.labeller.pin.unseal()).toBe(1234)
  })

  it("accepts typed host bindings such as Cloudflare vars", () => {
    expect(resolveServerEnv(labellerRegistry(), { env: { LABELLER_DRY_RUN: false, LABELLER_MIN_CONFIDENCE: 1, LABELLER_PIN: "1" } })).toMatchObject({
      labeller: { dryRun: false, minConfidence: 1 },
    })
  })

  it("reports invalid values with the declaration path and without the value", () => {
    for (const [name, value, message] of [
      ["LABELLER_DRY_RUN", "yes", "Expected a boolean: true, false, 1, or 0."],
      ["LABELLER_MIN_CONFIDENCE", "high", "Expected a finite number."],
      ["LABELLER_MIN_CONFIDENCE", "", "Expected a finite number."],
      ["LABELLER_MODE", "archive", "Expected one of \"draft\", \"send\"."],
    ] as const) {
      const error = capture(() => resolveServerEnv(labellerRegistry(), { env: { LABELLER_PIN: "1", [name]: value } }))
      expect(error).toMatchObject({
        code: "ENV_RUNTIME_VALUE_INVALID",
        details: { path: expect.stringMatching(/^env\.server\.labeller\./), source: "env" },
        message: "[vitehub] Runtime Env value is invalid.",
      })
      expect((error as Error).cause).toMatchObject({ message: expect.stringContaining(message) })
      expect(JSON.stringify(error)).not.toContain(value || "\"\"")
    }
  })

  it("parses provider values and reports invalid provider values in inspection", async () => {
    const registry = createRuntimeRegistry({
      enabled: env.boolean({ source: env.provider("settings", "enabled") }),
      limit: env.number({ secret: true, source: env.provider("settings", "limit") }),
    })
    const settings = (values: Record<string, string>) => ({ settings: defineEnvProvider({ read: async () => values }) })
    const loaded = await loadServerEnv(registry, { env: {} }, { providers: settings({ enabled: "1", limit: "25" }) })
    expect(loaded.enabled).toBe(true)
    expect((loaded.limit as SecretEnv<number>).unseal()).toBe(25)

    await expect(loadServerEnv(registry, { env: {} }, { providers: settings({ enabled: "maybe", limit: "25" }) }))
      .rejects.toMatchObject({ code: "ENV_RUNTIME_VALUE_INVALID", details: { path: "env.server.enabled", source: "provider" } })
    expect((await inspectServerEnv(registry, { env: {} }, { providers: settings({ enabled: "maybe", limit: "25" }) })).entries).toEqual([
      { masked: false, path: "env.server.enabled", provider: "settings", required: true, source: "provider", status: "invalid" },
      { masked: true, path: "env.server.limit", provider: "settings", required: true, source: "provider", status: "available" },
    ])
  })

  it("rejects secret enums and keeps secret values out of errors", () => {
    const secretEnum = { ...env.enum(["alpha-credential", "beta-credential"]), secret: true }
    const error = capture(() => createRuntimeRegistry({ credential: secretEnum }))
    expect(error).toMatchObject({ code: "ENV_DECLARATION_INVALID", details: { path: "env.credential" } })
    expect(String((error as Error).cause)).toContain("cannot be a secret enum")

    const registry = { credential: { required: true, schema: { kind: "enum" as const, values: ["alpha-credential"] }, secret: true, source: { kind: "env" as const, label: "env:CREDENTIAL", name: "CREDENTIAL", serializable: true as const } } }
    const invalid = capture(() => resolveServerEnv(registry, { env: { CREDENTIAL: "other" } }))
    expect(invalid).toMatchObject({ code: "ENV_RUNTIME_VALUE_INVALID", details: { path: "env.server.credential" } })
    expect(String((invalid as Error).cause)).not.toContain("alpha-credential")
    expect(describeServerEnv(registry).entries).toEqual([{ path: "env.server.credential", source: "env", secret: true, required: true, hasDefault: false, type: "enum" }])
  })

  it("describes the parsed type without exposing defaults", () => {
    expect(describeServerEnv(labellerRegistry()).entries).toEqual([
      { path: "env.server.labeller.dryRun", canonicalName: "VITEHUB_LABELLER_DRY_RUN", source: "env", secret: false, required: true, hasDefault: true, type: "boolean" },
      { path: "env.server.labeller.minConfidence", canonicalName: "VITEHUB_LABELLER_MIN_CONFIDENCE", source: "env", secret: false, required: true, hasDefault: true, type: "number" },
      { path: "env.server.labeller.mode", canonicalName: "VITEHUB_LABELLER_MODE", source: "env", secret: false, required: true, hasDefault: true, type: "\"draft\" | \"send\"" },
      { path: "env.server.labeller.retries", canonicalName: "VITEHUB_LABELLER_RETRIES", source: "env", secret: false, required: false, hasDefault: false, type: "number" },
      { path: "env.server.labeller.pin", canonicalName: "VITEHUB_LABELLER_PIN", source: "env", secret: true, required: true, hasDefault: false, type: "number" },
    ])
  })
})
