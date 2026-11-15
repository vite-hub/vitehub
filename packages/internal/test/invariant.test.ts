import { expect, it } from "vitest"

import { invariant, invariantError } from "../src/invariant.ts"

it("throws one code with the broken rule and a fix that asks for a bug report", () => {
  expect(() => invariant(false, "the deployment plan has no entry")).toThrow(expect.objectContaining({
    code: "INTERNAL_INVARIANT_FAILED",
    docs: "https://vitehub.dev/docs/development/diagnostics/internal_invariant_failed",
    fix: expect.stringContaining("https://github.com/vite-hub/vitehub/issues"),
    message: "ViteHub reached a state that it does not expect: the deployment plan has no entry",
  }))
})

it("passes a truthy condition and narrows it", () => {
  const value: string | undefined = "entry"
  invariant(value, "the value is set")
  expect(value.length).toBe(5)
  expect(invariantError("a branch ran").code).toBe("INTERNAL_INVARIANT_FAILED")
})
