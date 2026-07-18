import { describe, expect, it, vi } from "vitest"

const distEntry = new URL("../dist/index.js", import.meta.url)
const { EnvError } = await import(distEntry.href)

describe("published EnvError runtime", () => {
  it("rejects hostile constructor fields without invoking getters", () => {
    const getter = vi.fn(() => "private-accessor-secret")
    const details = Object.defineProperty({}, "source", { enumerable: true, get: getter })

    expect(() => new EnvError({ code: "ENV_SOURCE_FAILED", details } as never))
      .toThrow("[vitehub] EnvError requires valid error options.")
    expect(getter).not.toHaveBeenCalled()
  })

  it("keeps an exact cause behind its immutable public shape", () => {
    const cause = new Error("private-provider-secret")
    const error = new EnvError({ cause, code: "ENV_SOURCE_FAILED", details: { source: "custom" } })

    expect(error.cause).toBe(cause)
    expect(Reflect.set(error, "toJSON", () => ({ message: "private-provider-secret" }))).toBe(false)
    expect(error.toJSON()).toEqual({
      code: "ENV_SOURCE_FAILED",
      details: { source: "custom" },
      message: "[vitehub] Env source resolution failed.",
    })
    expect(JSON.stringify(error)).not.toContain("private-provider-secret")
  })
})
