import { describe, expect, it } from "vitest"

import { normalizeRuntimeDiagnosticError } from "../src/index.ts"

describe("Runtime diagnostic errors", () => {
  it("normalizes causes, AggregateError children, codes, cycles, and budgets", () => {
    const cause = Object.assign(new Error("Git authentication failed"), { code: "EAUTH" })
    const checkout = new Error("Checkout failed", { cause })
    const failure = new AggregateError([checkout, new Error("Restore failed")], "Workspace failed")
    Object.assign(cause, { cause: failure })

    expect(normalizeRuntimeDiagnosticError(failure, { maxStringLength: 128 })).toEqual({
      errors: [{
        cause: {
          cause: { message: "[Circular error cause]" },
          code: "EAUTH",
          message: "Git authentication failed",
          name: "Error",
        },
        message: "Checkout failed",
        name: "Error",
      }, {
        message: "Restore failed",
        name: "Error",
      }],
      message: "Workspace failed",
      name: "AggregateError",
    })
  })

  it("does not throw when an Error-like object rejects inspection", () => {
    const hostile = new Proxy({}, {
      get() { throw new Error("blocked property") },
      getOwnPropertyDescriptor() { throw new Error("blocked descriptor") },
    })

    expect(normalizeRuntimeDiagnosticError(hostile)).toEqual({ message: "Unknown error" })
  })
})
