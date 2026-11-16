import { expect, it } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"

const relayedCodes = ["AGENT_R0784", "AGENT_R0785", "AGENT_R0786", "AGENT_R0789", "AGENT_R0800", "AGENT_R0856", "AGENT_R0857"] as const

it("gives the codes that relay a provider or steer error a fix, and keeps their message as it is", () => {
  for (const code of relayedCodes) {
    const error = agentDiagnostics[code]({ message: "provider failed" })
    expect(error.message, code).toBe("provider failed")
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})
