import { asUnknownBoundary, hasRuntimeType } from "../src/internal/runtime-type.ts"
import { describe, expect, it } from "vitest"
import { Diagnostic } from "nostics"

import { formatRuntimeDiagnosticError, getViteHubErrorShape, normalizeRuntimeDiagnosticError, ViteHubError } from "../src/index.ts"

describe("Runtime diagnostic errors", () => {
  it("preserves Nostics metadata on instances and JSON records without making them public errors", () => {
    const diagnostic = new Diagnostic({
      cause: new Error("Provider failure"),
      code: "AGENT_MODEL_NOT_FOUND",
      docs: "https://vitehub.dev/docs/agent",
      fix: "Set the model in the Agent Definition.",
      sources: ["agents/support.ts:4:2"],
      why: "The Agent has no model.",
    })
    const serialized: unknown = JSON.parse(JSON.stringify(diagnostic))
    for (const error of [diagnostic, serialized]) {
      const normalized = normalizeRuntimeDiagnosticError(error)
      expect(normalized).toMatchObject({
        code: "AGENT_MODEL_NOT_FOUND",
        docs: "https://vitehub.dev/docs/agent",
        fix: "Set the model in the Agent Definition.",
        message: "The Agent has no model.",
        name: "AGENT_MODEL_NOT_FOUND",
        sources: ["agents/support.ts:4:2"],
      })
      expect(normalized.stack).toBeUndefined()
      expect(getViteHubErrorShape(error)).toBeUndefined()
      expect(normalizeRuntimeDiagnosticError(JSON.parse(JSON.stringify(normalized)))).toMatchObject({
        code: normalized.code,
        docs: normalized.docs,
        fix: normalized.fix,
        message: normalized.message,
        sources: normalized.sources,
      })
    }
  })

  it("formats diagnostics across package copies and transport without causes or stacks", () => {
    const record = {
      cause: new Error("Private provider failure"),
      docs: "https://vitehub.dev/docs/agent",
      fix: "Set a model.",
      name: "AGENT_MODEL_NOT_FOUND",
      sources: ["agents/support.ts:4:2"],
      stack: "Private stack",
      why: "The Agent has no model.",
    }
    const expected = [
      "[AGENT_MODEL_NOT_FOUND] The Agent has no model.",
      "Set a model.",
      "agents/support.ts:4:2",
      "https://vitehub.dev/docs/agent",
    ]
    for (const error of [record, normalizeRuntimeDiagnosticError(record)]) {
      const output = formatRuntimeDiagnosticError(error)
      for (const text of expected) expect(output).toContain(text)
      expect(output).not.toContain("Private")
    }
    expect(formatRuntimeDiagnosticError(new Error("Plain failure"))).toBe("Plain failure")
    expect(formatRuntimeDiagnosticError("Plain failure")).toBe("Plain failure")
    expect(formatRuntimeDiagnosticError(new ViteHubError("FAILED", "Operation failed"))).toBe("[FAILED] Operation failed")
  })

  it.each(["instance", "serialized"])("bounds %s diagnostic metadata with the shared string and node budgets", (form) => {
    const diagnostic = {
      ...(form === "instance" ? { code: "FAILED", message: "Failed" } : { name: "FAILED", why: "Failed" }),
      docs: "d".repeat(10_000),
      fix: "f".repeat(10_000),
      sources: Array.from({ length: 10_000 }, () => "s".repeat(100)),
    }
    const normalized = normalizeRuntimeDiagnosticError(diagnostic, { maxErrors: 3, maxStringLength: 64 })
    expect(normalized.docs?.length).toBeLessThanOrEqual(64)
    expect(normalized.fix?.length).toBeLessThanOrEqual(64)
    expect(normalized.sources?.length).toBeLessThanOrEqual(3)
    const strings = [normalized.message, normalized.name, normalized.code, normalized.docs, normalized.fix, ...(normalized.sources || [])]
    const total = strings.reduce<number>((sum, value) => sum + (hasRuntimeType(value, "string") ? value.length : 0), 0)
    expect(total).toBeLessThanOrEqual(64 * 4)
  })

  it("ignores hostile and cyclic diagnostic metadata", () => {
    const sources: unknown[] = ["agents/support.ts:4:2"]
    sources.push(sources)
    Object.defineProperty(sources, "2", { get() { throw new Error("blocked source") } })
    const record = {
      get docs() { throw new Error("blocked docs") },
      get fix() { throw new Error("blocked fix") },
      name: "FAILED",
      sources,
      why: "Operation failed",
    }
    expect(normalizeRuntimeDiagnosticError(record)).toEqual({
      code: "FAILED",
      message: "Operation failed",
      name: "FAILED",
      sources: ["agents/support.ts:4:2"],
    })
    const hostileSources = new Proxy([], { get() { throw new Error("blocked sources") } })
    expect(formatRuntimeDiagnosticError({ name: "FAILED", sources: hostileSources, why: "Operation failed" })).toBe("[FAILED] Operation failed")
  })

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
