import { Diagnostic, formatDiagnostic } from "nostics"
import { describe, expect, it } from "vitest"

import { defineErrors, type Result } from "@vite-hub/runtime"

import { formatRuntimeDiagnosticError, normalizeRuntimeDiagnosticError } from "../src/index.ts"

const errors = defineErrors({
  docs: "https://vitehub.dev/docs/example",
  codes: {
    EXAMPLE_NOT_FOUND: {
      why: ({ key }: { key: string }) => `The key "${key}" does not exist.`,
      fix: "Write the key before you read it.",
    },
  },
})

async function read(key: string): Promise<Result<string, "EXAMPLE_NOT_FOUND">> {
  if (key !== "found") return [errors.EXAMPLE_NOT_FOUND({ key }), undefined]
  return [undefined, "value"]
}

describe("defineErrors", () => {
  it("creates Nostics diagnostics with code, why, fix, docs, and cause", () => {
    const cause = new Error("provider failed")
    const error = errors.EXAMPLE_NOT_FOUND({ cause, key: "settings" })

    expect(error).toBeInstanceOf(Diagnostic)
    expect(error).toMatchObject({
      cause,
      code: "EXAMPLE_NOT_FOUND",
      docs: "https://vitehub.dev/docs/example#example_not_found",
      fix: "Write the key before you read it.",
      message: "The key \"settings\" does not exist.",
      name: "EXAMPLE_NOT_FOUND",
      why: "The key \"settings\" does not exist.",
    })
    expect(formatDiagnostic(error)).toContain("fix: Write the key before you read it.")
  })

  it("serializes the public fields without cause or stack", () => {
    const error = errors.EXAMPLE_NOT_FOUND({ cause: new Error("token=secret"), key: "settings" })

    expect(JSON.parse(JSON.stringify({ error }))).toEqual({
      error: {
        code: "EXAMPLE_NOT_FOUND",
        docs: "https://vitehub.dev/docs/example#example_not_found",
        fix: "Write the key before you read it.",
        name: "EXAMPLE_NOT_FOUND",
        why: "The key \"settings\" does not exist.",
      },
    })
    expect(error.stack).toContain("EXAMPLE_NOT_FOUND")
  })

  it("keeps the code, fix, and docs in runtime diagnostics", () => {
    const error = errors.EXAMPLE_NOT_FOUND({ key: "settings" })

    expect(normalizeRuntimeDiagnosticError(error)).toMatchObject({
      code: "EXAMPLE_NOT_FOUND",
      docs: "https://vitehub.dev/docs/example#example_not_found",
      fix: "Write the key before you read it.",
    })
    expect(formatRuntimeDiagnosticError(error)).toContain("[EXAMPLE_NOT_FOUND]")
  })

  it("keeps catalog data in memory and omits it from public JSON", () => {
    const catalog = defineErrors({
      docs: "https://vitehub.dev/docs/example",
      codes: {
        EXAMPLE_RETRY: {
          why: ({ key }: { key: string }) => `Could not read ${key}.`,
          fix: ({ delay }: { delay: number }) => `Retry in ${delay} seconds.`,
          data: ({ attempt }: { attempt: number }) => ({ attempt }),
        },
        EXAMPLE_BUSY: { why: "Busy.", docs: false, data: { retryAfter: 10 } },
      },
    })
    const cause = new Error("token=secret")
    const sources = ["private.ts:1:2"]
    const error = catalog.EXAMPLE_RETRY({ key: "settings", delay: 10, attempt: 1, cause, sources })

    expect(error).toBeInstanceOf(Diagnostic)
    expect(error.data.attempt).toBe(1)
    expect(error.cause).toBe(cause)
    expect(error.sources).toEqual(sources)
    expect(error.stack).toContain("EXAMPLE_RETRY")
    const publicError = {
      code: "EXAMPLE_RETRY",
      name: "EXAMPLE_RETRY",
      why: "Could not read settings.",
      fix: "Retry in 10 seconds.",
      docs: "https://vitehub.dev/docs/example#example_retry",
    }
    expect(error.toJSON()).toEqual(publicError)
    expect(JSON.parse(JSON.stringify(error))).toEqual(publicError)

    const busy = catalog.EXAMPLE_BUSY()
    expect(busy.data.retryAfter).toBe(10)
    expect(busy.toJSON()).toEqual({ code: "EXAMPLE_BUSY", name: "EXAMPLE_BUSY", why: "Busy.", docs: undefined, fix: undefined })
    expect(JSON.parse(JSON.stringify(busy))).toEqual({ code: "EXAMPLE_BUSY", name: "EXAMPLE_BUSY", why: "Busy." })
  })
})

describe("Result", () => {
  it("returns the error first and the data second", async () => {
    const [error, value] = await read("missing")
    expect(error?.code).toBe("EXAMPLE_NOT_FOUND")
    expect(value).toBeUndefined()

    expect(await read("found")).toEqual([undefined, "value"])
  })
})
