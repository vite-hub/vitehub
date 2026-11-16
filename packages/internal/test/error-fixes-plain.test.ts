import { describe, expect, it } from "vitest"
import * as v from "valibot"

import { readConsoleSigningKey } from "../src/console-signature.ts"
import { internalErrorDiagnostics } from "../src/error-diagnostics.ts"
import { assertKnownPresetOptions, readPresetSelection } from "../src/presets.ts"
import { deriveViteHubSecret } from "../src/secret.ts"
import { withValibotJsonSchema } from "../src/valibot.ts"

/** The codes that replaced plain errors in the Console signature, preset, secret, and Valibot helpers. */
const codes = [
  "INTERNAL_CONSOLE_KEY_NAME_INVALID",
  "INTERNAL_CONSOLE_PRIVATE_KEY_INVALID",
  "INTERNAL_CONSOLE_PRIVATE_KEY_VARIABLES_MULTIPLE",
  "INTERNAL_CONSOLE_PRIVATE_KEY_VARIABLE_INVALID",
  "INTERNAL_PRESET_OPTION_UNKNOWN",
  "INTERNAL_PRESET_TUPLE_INVALID",
  "INTERNAL_SECRET_PURPOSE_MISSING",
  "INTERNAL_SECRET_TOO_SHORT",
  "INTERNAL_VALIBOT_JSON_SCHEMA_TARGET_UNSUPPORTED",
] as const

type Params = { key: string, label: string, minimum: number, name: string, owner: string, prefix: string, target: string, variable: string, variables: string }

describe("internal plain error codes", () => {
  it.each(codes)("%s has a fix and its own docs page", (code) => {
    // Each code takes its own params. One object that has all of them fits every code.
    const create = internalErrorDiagnostics[code] as (params: Params) => Error & { docs?: string, fix?: string }
    const error = create({ key: "k", label: "Agent preset", minimum: 32, name: "ci", owner: "Agent", prefix: "P_", target: "draft-04", variable: "V", variables: "A, B" })
    expect(error.fix).toMatch(/\S/)
    expect(error.docs).toBe(`https://vitehub.dev/docs/development/diagnostics/${code.toLowerCase()}`)
  })

  it("reports two Console private key variables with their code and fix", () => {
    expect(() => readConsoleSigningKey({ VITEHUB_CONSOLE_PRIVATE_KEY_A: "a".repeat(43), VITEHUB_CONSOLE_PRIVATE_KEY_B: "b".repeat(43) })).toThrow(expect.objectContaining({
      code: "INTERNAL_CONSOLE_PRIVATE_KEY_VARIABLES_MULTIPLE",
      fix: expect.stringContaining("VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>"),
      message: "[vitehub] Set one VITEHUB_CONSOLE_PRIVATE_KEY_<NAME> variable. This environment has VITEHUB_CONSOLE_PRIVATE_KEY_A, VITEHUB_CONSOLE_PRIVATE_KEY_B.",
    }))
  })

  it("reports a bad preset tuple and an unknown preset option with their codes and fixes", () => {
    expect(() => readPresetSelection(["preset"], "Content")).toThrow(expect.objectContaining({
      code: "INTERNAL_PRESET_TUPLE_INVALID",
      fix: expect.stringContaining("[preset, { ...options }]"),
      message: "[vitehub] Content extends tuple requires [preset, options] with an options object.",
    }))
    expect(() => assertKnownPresetOptions({ known: 1 }, { typo: true }, "Agent preset")).toThrow(expect.objectContaining({
      code: "INTERNAL_PRESET_OPTION_UNKNOWN",
      message: "[vitehub] Unknown Agent preset option \"typo\".",
    }))
  })

  it("reports a short VITEHUB_SECRET with its code and fix", async () => {
    await expect(deriveViteHubSecret("short", "purpose")).rejects.toMatchObject({
      code: "INTERNAL_SECRET_TOO_SHORT",
      fix: expect.stringContaining("VITEHUB_SECRET"),
    })
  })

  it("reports an unsupported JSON Schema target with its code and fix", () => {
    const schema = withValibotJsonSchema(v.string())
    const standard = schema["~standard"] as unknown as { jsonSchema: { input(options: { target: string }): unknown } }
    expect(() => standard.jsonSchema.input({ target: "draft-04" })).toThrow(expect.objectContaining({
      code: "INTERNAL_VALIBOT_JSON_SCHEMA_TARGET_UNSUPPORTED",
      fix: expect.stringContaining("draft-2020-12"),
    }))
  })
})
