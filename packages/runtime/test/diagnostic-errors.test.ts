import { asUnknownBoundary, hasRuntimeType } from "../src/internal/runtime-type.ts"
import { describe, expect, it } from "vitest"

import { normalizeRuntimeDiagnosticError, ViteHubError } from "../src/index.ts"

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

  it("shares one bound across broad error graphs and scalar strings", () => {
    const broad = (depth: number): Error => Object.assign(
      depth === 0
        ? new Error("leaf".repeat(100))
        : new AggregateError(Array.from({ length: 8 }, () => broad(depth - 1)), "branch".repeat(100)),
      {
        code: "code".repeat(100),
        status: "status".repeat(100),
        statusCode: "status-code".repeat(100),
      },
    )

    const normalized = normalizeRuntimeDiagnosticError(broad(4), { maxErrors: 4, maxStringLength: 64 })
    const nodes: Array<Record<string, unknown>> = []
    const visit = (error: Record<string, unknown>) => {
      nodes.push(error)
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      if (error.cause) visit(error.cause as Record<string, unknown>)
      // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
      for (const child of (error.errors as Array<Record<string, unknown>> | undefined) || []) visit(child)
    }
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    visit(asUnknownBoundary(normalized) as Record<string, unknown>)

    expect(nodes.length).toBeLessThanOrEqual(5)
    expect(JSON.stringify(normalized).length).toBeLessThan(2_000)
    for (const node of nodes) {
      for (const value of Object.values(node)) {
        if (hasRuntimeType(value, "string")) expect(value.length).toBeLessThanOrEqual(64)
      }
    }
  })

  it("applies the whole-graph budget to public error details", () => {
    const cause = new AggregateError([
      new Error("First nested failure"),
      new Error("Second nested failure"),
    ], "Nested failures")
    const error = new ViteHubError("PROVIDER_FAILED", "Provider failed", {
      cause,
      details: {
        items: Array.from({ length: 100 }, (_item, index) => ({
          label: `private-${index}-${"x".repeat(1_000)}`,
        })),
        nested: { deeper: { value: "y".repeat(16_000) } },
      },
    })

    const normalized = normalizeRuntimeDiagnosticError(error, {
      maxDepth: 2,
      maxErrors: 3,
      maxStringLength: 64,
    })
    const serialized = JSON.stringify(normalized)

    expect(serialized.length).toBeLessThan(1_000)
    expect(serialized).not.toContain("private-0")
    expect(serialized).not.toContain("y".repeat(1_000))
    expect(normalized.cause).toMatchObject({
      errors: [
        { message: "First nested failure" },
        { message: "Second nested failure" },
      ],
      message: "Nested failures",
    })
    expect(normalized.details).toBeUndefined()
  })
})
