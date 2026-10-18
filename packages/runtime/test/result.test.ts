import { Diagnostic, formatDiagnostic } from "nostics"
import { describe, expect, it } from "vitest"

import { defineErrors, formatRuntimeDiagnosticError, normalizeRuntimeDiagnosticError, type Result } from "../src/index.ts"

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
})

describe("Result", () => {
  it("returns the error first and the data second", async () => {
    const [error, value] = await read("missing")
    expect(error?.code).toBe("EXAMPLE_NOT_FOUND")
    expect(value).toBeUndefined()

    expect(await read("found")).toEqual([undefined, "value"])
  })
})
