import { describe, expect, it } from "vitest"

const distEntry = new URL("../dist/index.js", import.meta.url)
const { ViteHubError } = await import(distEntry.href)

describe("published ViteHubError runtime", () => {
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
