import { defineDiagnostics, Diagnostic } from "nostics"
import { expect, it } from "vitest"

import { defineErrors, toResultError, ViteHubError } from "../src/index.ts"
import { loadDiagnosticCopy } from "./fixtures/diagnostic-copy.ts"

const errors = defineErrors({
  docs: "https://vitehub.dev/docs/example",
  codes: {
    EXAMPLE_NOT_FOUND: { why: ({ key }: { key: string }) => `The key "${key}" does not exist.` },
    EXAMPLE_BUSY: { why: "Busy.", data: { retryAfter: 10 } },
  },
})

const otherErrors = defineErrors({
  docs: "https://vitehub.dev/docs/other",
  codes: { OTHER_FAILED: { why: "Failed." } },
})

it("matches an error of the catalog and of the code", () => {
  const error = errors.EXAMPLE_NOT_FOUND({ key: "settings" })

  expect(errors.is(error)).toBe(true)
  expect(errors.EXAMPLE_NOT_FOUND.is(error)).toBe(true)
  expect(errors.EXAMPLE_BUSY.is(error)).toBe(false)
})

it("rejects errors of another catalog and plain errors", () => {
  const other = otherErrors.OTHER_FAILED()

  expect(errors.is(other)).toBe(false)
  expect(errors.EXAMPLE_NOT_FOUND.is(other)).toBe(false)
  expect(otherErrors.is(errors.EXAMPLE_BUSY())).toBe(false)
  for (const value of [
    new Error("EXAMPLE_NOT_FOUND"),
    Object.assign(new Error("Not a diagnostic"), { code: "EXAMPLE_NOT_FOUND" }),
    new ViteHubError("EXAMPLE_NOT_FOUND", "Application error"),
    JSON.parse(JSON.stringify(errors.EXAMPLE_BUSY())),
    { code: "EXAMPLE_NOT_FOUND", why: "Not an error" },
    "EXAMPLE_NOT_FOUND",
    undefined,
  ]) {
    expect(errors.is(value)).toBe(false)
    expect(errors.EXAMPLE_NOT_FOUND.is(value)).toBe(false)
  }
})

it("matches a diagnostic with a catalog code from another copy of Nostics", async () => {
  const copy = await loadDiagnosticCopy(new URL("../", import.meta.url))
  const error = copy.create({ code: "EXAMPLE_BUSY", why: "Busy.", data: { retryAfter: 10 } })
  const registry = defineDiagnostics({ codes: { EXAMPLE_BUSY: { why: "Busy." } } })

  expect(error).not.toBeInstanceOf(Diagnostic)
  expect(registry.is(error)).toBe(false)
  expect(errors.is(error)).toBe(true)
  expect(errors.EXAMPLE_BUSY.is(error)).toBe(true)
  expect(errors.EXAMPLE_NOT_FOUND.is(error)).toBe(false)
})

it("matches a copy that toResultError makes of a locked diagnostic", () => {
  const diagnostic = Object.freeze(new Diagnostic({ code: "EXAMPLE_BUSY", why: "Busy.", data: { retryAfter: 10 } }))
  const error = toResultError(diagnostic)

  expect(error).not.toBe(diagnostic)
  expect(errors.is(error)).toBe(true)
  expect(errors.EXAMPLE_BUSY.is(error)).toBe(true)
})

it("keeps is out of the enumerable keys and accepts unbound checks", () => {
  expect(Object.keys(errors)).toEqual(["EXAMPLE_NOT_FOUND", "EXAMPLE_BUSY"])
  expect(Object.entries(errors).map(([code]) => code)).toEqual(["EXAMPLE_NOT_FOUND", "EXAMPLE_BUSY"])
  expect(Object.getOwnPropertyDescriptor(errors, "is")).toMatchObject({ configurable: false, enumerable: false, writable: false })

  const failures = [errors.EXAMPLE_BUSY(), otherErrors.OTHER_FAILED(), new Error("plain")]
  expect(failures.filter(errors.is)).toEqual([failures[0]])
  expect(failures.filter(errors.EXAMPLE_BUSY.is)).toEqual([failures[0]])
})
