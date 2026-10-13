import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { toBrowserError } from "../src/errors.ts"

describe("toBrowserError", () => {
  it("preserves messages from errors created in another realm", () => {
    const error = runInNewContext("new Error('cross-realm failure')")
    expect(error).not.toBeInstanceOf(Error)
    expect(toBrowserError(error).message).toBe("cross-realm failure")
  })

  it("normalizes errors with a hostile Symbol.toStringTag", () => {
    const error = {
      get [Symbol.toStringTag]() {
        throw new Error("tag access failed")
      },
      toString: () => "hostile error",
    }

    expect(toBrowserError(error).message).toBe("hostile error")
  })

  it("normalizes errors with an unreadable message", () => {
    const error = runInNewContext(`(() => {
      const error = new Error()
      Object.defineProperty(error, "message", { get() { throw new Error("message access failed") } })
      return error
    })()`)

    expect(() => toBrowserError(error)).not.toThrow()
    expect(toBrowserError(error).code).toBe("BROWSER_RUNTIME_ERROR")
  })

  it.each([undefined, null])("falls back when an Error-like message is %s", (message) => {
    const error = {
      [Symbol.toStringTag]: "Error",
      message,
      toString: () => "provider failed",
    }

    expect(toBrowserError(error).message).toBe("provider failed")
  })
})
