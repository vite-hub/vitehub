import { describe, expect, it, vi } from "vitest"
import { Diagnostic } from "nostics"
import { formatRuntimeDiagnosticError } from "@vite-hub/runtime"

import { defineCapability, normalizeCapabilities } from "../src/capability-runtime.ts"
import { getAgentFromRegistry } from "../src/index.ts"
import { formatAgentError, toAgentPublicError } from "../src/agent-error.ts"
import { withAgentToolStepReporting } from "../src/tool-runtime.ts"
import { agentGeneratedRuntimeError } from "../src/server/generated-runtime-error.ts"
import { agentDiagnostics, isAgentTypeDiagnostic } from "../src/agent-diagnostics.ts"

describe("Agent diagnostics", () => {
  it("preserves the HTTP input-error classification for application errors", () => {
    expect(isAgentTypeDiagnostic(new TypeError("Invalid application input"))).toBe(true)
    expect(isAgentTypeDiagnostic(agentDiagnostics.AGENT_R0004({ message: "Invalid attachment" }))).toBe(true)
    expect(isAgentTypeDiagnostic(new Error("Application failure"))).toBe(false)
    expect(isAgentTypeDiagnostic(agentDiagnostics.AGENT_R0007({ message: "Attachment too large" }))).toBe(false)
  })

  it("keeps stable codes in generated Agent runtime errors", () => {
    for (const code of ["AGENT_R0892", "AGENT_R0893", "AGENT_R0894", "AGENT_R0895", "AGENT_R0896", "AGENT_R0897"] as const) {
      expect(agentGeneratedRuntimeError(code, "Generated runtime failed.")).toMatchObject({
        code,
        message: "Generated runtime failed.",
      })
    }
  })

  it("reports a duplicate Capability with a code and a fix without logging", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const capability = defineCapability({ id: "search" })
      expect(() => normalizeCapabilities([capability, capability])).toThrowError(expect.objectContaining({
        code: "AGENT_C0009",
        fix: "Remove the duplicate Capability or give each Capability a unique id.",
      }))
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
    }
    finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })

  it("keeps registry suggestions and supplies a repair instruction", async () => {
    await expect(getAgentFromRegistry("triage", { triager: () => ({}) })).rejects.toMatchObject({
      code: "AGENT_R0001",
      message: expect.stringContaining('Did you mean "triager"?'),
      fix: expect.stringContaining("Use a discovered Agent name"),
    })
    await expect(getAgentFromRegistry("triager", { triager: () => ({ default: undefined }) })).rejects.toMatchObject({
      code: "AGENT_R0002",
      fix: expect.stringContaining("default export"),
    })
  })

  it("preserves tool diagnostic guidance and the original failure", async () => {
    const failure = new Diagnostic({
      cause: new Error("private provider response"),
      code: "SEARCH_INDEX_MISSING",
      docs: "https://example.com/search",
      fix: "Create the search index before searching.",
      sources: ["server/agents/search.ts:8:3"],
      why: "Search index is missing.",
    })
    const reporter = vi.fn()
    const tools = withAgentToolStepReporting({
      search: { name: "search", execute() { throw failure } },
    }, reporter)

    await expect(tools.search.execute()).rejects.toBe(failure)
    const text = formatRuntimeDiagnosticError(failure)
    expect(reporter).toHaveBeenLastCalledWith({ toolErrors: [expect.objectContaining({ output: text })] })
    expect(text).toContain("SEARCH_INDEX_MISSING")
    expect(text).toContain("Create the search index")
    expect(text).not.toContain("private provider response")
    expect(formatAgentError(JSON.parse(JSON.stringify(failure)))).toBe(text)
    expect(toAgentPublicError(failure, "http")).toEqual({ code: "INTERNAL", error: "Agent request failed." })
  })

  it("keeps cancellation errors unchanged in tool reporting", async () => {
    const failure = new DOMException("Cancelled", "AbortError")
    const tools = withAgentToolStepReporting({
      search: { name: "search", execute() { throw failure } },
    }, vi.fn())
    await expect(tools.search.execute()).rejects.toBe(failure)
  })
})
