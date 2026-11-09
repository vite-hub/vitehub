import { expect, it } from "vitest"

import { envErrorDiagnostics } from "../src/error-diagnostics.ts"
import { parseEnvSchema } from "../src/env-schema/profile.ts"

// These published codes have no call site left.
const unused = new Set(["ENV_R0007", "ENV_R0024"])

it("gives each raised Env code a fix and its own docs page", () => {
  for (const [code, create] of Object.entries(envErrorDiagnostics)) {
    if (unused.has(code)) continue
    const error = create({ message: "message" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/env/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports an invalid env-spec schema with a code and a fix", () => {
  expect(() => parseEnvSchema('A=""', "empty.env")).toThrow(expect.objectContaining({
    code: "ENV_B0006",
    fix: expect.stringContaining("env-spec"),
    message: expect.stringContaining("Required default cannot be empty"),
  }))
})
