import { describe, expect, it } from "vitest"

const distEntry = new URL("../dist/index.js", import.meta.url)
const { formatRuntimeDiagnosticError, normalizeRuntimeDiagnosticError, ViteHubError } = await import(distEntry.href)

describe("published ViteHubError runtime", () => {
  it("exports diagnostic normalization and formatting for transported errors", () => {
    const record = normalizeRuntimeDiagnosticError({
      name: "SEARCH_INDEX_MISSING",
      why: "Search index is missing.",
      fix: "Create the search index.",
      cause: { token: "private provider response" },
      stack: "private stack",
    })
    expect(record).toMatchObject({ code: "SEARCH_INDEX_MISSING", fix: "Create the search index." })
    const text = formatRuntimeDiagnosticError(record)
    expect(text).toContain("[SEARCH_INDEX_MISSING] Search index is missing.")
    expect(text).toContain("fix: Create the search index.")
    expect(text).not.toContain("private")
  })

  it("keeps its construction-time public shape after source and instance mutation", () => {
    const cause = new Error("private provider cause")
    const details = { nested: { provider: "fixture" } }
    const error = new ViteHubError("PROVIDER_FAILED", "The provider request failed.", { cause, details })

    details.nested.provider = "mutated-secret"
    Object.defineProperties(error, {
      code: { value: "MUTATED_SECRET" },
      details: { value: { provider: "mutated-secret" } },
      message: { value: "Bearer mutated-secret" },
      requestId: { value: "mutated-secret" },
      retryable: { value: false },
    })
    expect(Reflect.set(error, "toJSON", () => ({ message: "mutated-secret" }))).toBe(false)

    expect(error.toJSON()).toEqual({
      code: "PROVIDER_FAILED",
      details: { nested: { provider: "fixture" } },
      message: "The provider request failed.",
      name: "ViteHubError",
    })
    expect(Object.keys(error)).not.toContain("toJSON")
    expect(error.cause).toBe(cause)
    expect(JSON.stringify(error)).not.toMatch(/mutated-secret|private provider cause/)
  })

  it("rejects non-JSON details with a fixed failure", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    for (const details of [{ secret: 1n }, cyclic]) {
      expect(() => new ViteHubError("PROVIDER_FAILED", "The provider request failed.", { details } as never))
        .toThrow("[vitehub] ViteHubError requires a valid public error contract.")
    }
  })
})
