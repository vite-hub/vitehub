import { Diagnostic, type InferDiagnosticCodes } from "nostics"
import { expect, it } from "vitest"

import { agentDiagnostics, isAgentTypeDiagnostic } from "../src/agent-diagnostics.ts"
import { messageDiagnostics } from "../src/message-diagnostics.ts"
import { validateMessage } from "../src/messages.ts"

it("reuses message diagnostic handles and keeps their input-error classification", () => {
  const cause = new Error("Original failure")
  const sources = ["messages.ts:1:1"]
  expect(Object.keys(messageDiagnostics)).toHaveLength(23)
  for (const code of Object.keys(messageDiagnostics) as Array<InferDiagnosticCodes<typeof messageDiagnostics>>) {
    expect(agentDiagnostics[code]).toBe(messageDiagnostics[code])
    const error = agentDiagnostics[code]({ message: "Invalid message", cause, sources })
    expect(error).toBeInstanceOf(Diagnostic)
    expect(error.cause).toBe(cause)
    expect(error.sources).toBe(sources)
    expect(error).toMatchObject({ code, name: code, message: "Invalid message", docs: `https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}` })
    expect(error.fix).toMatch(/\S/)
    expect(agentDiagnostics[code]().message).toBe("")
    expect(agentDiagnostics[code]({ message: 42 }).message).toBe("42")
    expect(isAgentTypeDiagnostic(error)).toBe(true)
  }
  try {
    validateMessage({ id: "", role: "user", parts: [] })
    expect.fail("Expected a message diagnostic")
  }
  catch (error) {
    expect(error).toBeInstanceOf(Diagnostic)
    expect(error).toMatchObject({ code: "AGENT_R0647" })
    expect(isAgentTypeDiagnostic(error)).toBe(true)
  }
})

it("checks errors of both Agent registries with agentDiagnostics.is", () => {
  expect(agentDiagnostics.is(messageDiagnostics.AGENT_R0647({ message: "m" }))).toBe(true)
  expect(agentDiagnostics.is(agentDiagnostics.AGENT_R0618({ message: "m" }))).toBe(true)
  expect(agentDiagnostics.is(new Error("m"))).toBe(false)
  expect(Object.keys(agentDiagnostics)).not.toContain("is")
})
