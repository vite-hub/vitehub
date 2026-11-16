import { expect, it } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { inputCommands } from "../src/capabilities/input-commands.ts"
import { title } from "../src/capabilities/title.ts"

const codes = [
  "AGENT_R0870",
  "AGENT_R0871",
  "AGENT_R0872",
  "AGENT_R0873",
  "AGENT_R0874",
  "AGENT_R0875",
  "AGENT_R0876",
  "AGENT_R0877",
  "AGENT_R0878",
  "AGENT_R0879",
  "AGENT_R0880",
  "AGENT_R0881",
  "AGENT_R0882",
  "AGENT_R0883",
  "AGENT_R0885",
  "AGENT_R0886",
  "AGENT_R0887",
  "AGENT_R0888",
  "AGENT_R0924",
  "AGENT_R0925",
  "AGENT_R0926",
  "AGENT_R0927",
  "AGENT_R0929",
  "AGENT_R0932",
  "AGENT_R0933",
  "AGENT_R0934",
  "AGENT_R0935",
  "AGENT_R0936",
  "AGENT_R0937",
  "AGENT_R0938",
  "AGENT_R0941",
  "AGENT_R0942",
  "AGENT_R0943",
  "AGENT_R0944",
  "AGENT_R0945",
  "AGENT_R0950",
  "AGENT_R0951",
  "AGENT_R0952",
  "AGENT_R0953",
  "AGENT_R0954",
  "AGENT_R0955",
  "AGENT_R0956",
  "AGENT_R0957",
  "AGENT_R0958",
  "AGENT_R0959",
  "AGENT_R0960",
  "AGENT_R0961",
  "AGENT_R0962",
  "AGENT_R0963",
  "AGENT_R0970",
  "AGENT_R0971",
  "AGENT_R0972",
  "AGENT_R0973",
  "AGENT_R0974",
  "AGENT_R0976",
  "AGENT_R0979",
  "AGENT_R0981",
  "AGENT_R0982",
  "AGENT_R0983",
  "AGENT_R0991",
  "AGENT_R0992",
  "AGENT_R0993",
  "AGENT_R0994",
  "AGENT_R0995",
  "AGENT_R0996",
  "AGENT_R0997",
  "AGENT_R0998",
  "AGENT_R0999",
  "AGENT_R1000",
  "AGENT_R1001",
  "AGENT_R1002",
  "AGENT_R1003",
  "AGENT_R1004",
  "AGENT_R1007",
  "AGENT_R1011",
  "AGENT_R1012",
  "AGENT_R1013",
  "AGENT_R1027",
  "AGENT_R1028",
  "AGENT_R1030",
  "AGENT_R1031",
  "AGENT_R1032",
  "AGENT_R1033",
  "AGENT_R1034",
  "AGENT_R1035",
] as const

it("gives each Agent runtime code from AGENT_R0870 to the end of the catalog a fix and its own docs page", () => {
  for (const code of codes) {
    const error = agentDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports title() with a timeoutMs of 0 with a code and a fix", () => {
  expect(() => title({ timeoutMs: 0 })).toThrow(expect.objectContaining({
    code: "AGENT_R0926",
    fix: expect.stringContaining("title({ timeoutMs })"),
  }))
})

it("reports title() with an empty model with a code and a fix", () => {
  expect(() => title({ model: "" })).toThrow(expect.objectContaining({
    code: "AGENT_R0925",
    fix: expect.stringContaining("title({ model })"),
  }))
})

it("reports inputCommands() with a debug value that is not a boolean with a code and a fix", () => {
  // SAFETY: The test passes an invalid value to check the runtime error.
  expect(() => inputCommands({ debug: "yes" } as never)).toThrow(expect.objectContaining({
    code: "AGENT_R1034",
    fix: expect.stringContaining("inputCommands({ debug })"),
  }))
})
