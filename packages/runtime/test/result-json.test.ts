import { Diagnostic } from "nostics"
import { expect, expectTypeOf, it } from "vitest"

import { toResultError } from "../src/index.ts"

it("prepares the same diagnostic for public JSON and preserves its code type", () => {
  const cause = new Error("private provider token")
  const data = { token: "private metadata" }
  const sources = ["private/provider.ts:42"]
  const diagnostic = Object.assign(new Diagnostic({ code: "EXAMPLE_INVALID", why: "Invalid input.", cause, data, sources }), {
    code: "EXAMPLE_INVALID" as const,
    name: "ProviderError",
  })
  const stack = diagnostic.stack
  const error = toResultError(diagnostic)

  expectTypeOf(error.code).toEqualTypeOf<"EXAMPLE_INVALID">()
  expectTypeOf(error.name).toEqualTypeOf<"EXAMPLE_INVALID">()
  expect(error).toBe(diagnostic)
  expect(error.name).toBe("EXAMPLE_INVALID")
  expect(error.cause).toBe(cause)
  expect(error.data).toBe(data)
  expect(error.sources).toBe(sources)
  expect(error.stack).toBe(stack)
  expect(error.toJSON()).toEqual({ code: "EXAMPLE_INVALID", name: "EXAMPLE_INVALID", why: "Invalid input.", fix: undefined, docs: undefined })
  expect(JSON.parse(JSON.stringify(error))).toEqual({ code: "EXAMPLE_INVALID", name: "EXAMPLE_INVALID", why: "Invalid input." })
  expect(toResultError(error)).toBe(error)
})

it.each([
  ["frozen", (error: Diagnostic<unknown>) => Object.freeze(error)],
  ["sealed", (error: Diagnostic<unknown>) => Object.seal(error)],
  ["nonextensible", (error: Diagnostic<unknown>) => Object.preventExtensions(error)],
  ["locked name", (error: Diagnostic<unknown>) => Object.defineProperty(error, "name", { configurable: false })],
  ["locked serializer", (error: Diagnostic<unknown>) => Object.defineProperty(error, "toJSON", { configurable: false, value: error.toJSON })],
] as const)("converts a %s diagnostic without changing the original", (_label, protect) => {
  const cause = new Error("private provider token")
  const data = { token: "private metadata" }
  const sources = ["private/provider.ts:42"]
  const diagnostic = new Diagnostic({ code: "EXAMPLE_INVALID", why: "Invalid input.", fix: "Try again.", docs: "https://example.test/errors", cause, data, sources })
  diagnostic.name = "ProviderError"
  const stack = diagnostic.stack
  const serialize = diagnostic.toJSON
  protect(diagnostic)

  const error = toResultError(diagnostic)

  expect(error).not.toBe(diagnostic)
  expect(error).toBeInstanceOf(Diagnostic)
  expect(error.name).toBe("EXAMPLE_INVALID")
  expect(error.cause).toBe(cause)
  expect(error.data).toBe(data)
  expect(error.sources).toBe(sources)
  expect(error.stack).toBe(stack)
  expect(error.toJSON()).toEqual({ code: "EXAMPLE_INVALID", name: "EXAMPLE_INVALID", why: "Invalid input.", fix: "Try again.", docs: "https://example.test/errors" })
  expect(JSON.stringify(error)).not.toContain("private")
  expect(diagnostic.name).toBe("ProviderError")
  expect(diagnostic.toJSON).toBe(serialize)
})
