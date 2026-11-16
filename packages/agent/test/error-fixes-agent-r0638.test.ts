import { expect, it } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { defineAgent } from "../src/index.ts"
import { defineAgentRunEvents } from "../src/run-events.ts"
import { createProcessAgentCapacity } from "../src/runtime/process.ts"

const codes = [
  "AGENT_R0638",
  "AGENT_R0639",
  "AGENT_R0640",
  "AGENT_R0641",
  "AGENT_R0642",
  "AGENT_R0643",
  "AGENT_R0669",
  "AGENT_R0670",
  "AGENT_R0671",
  "AGENT_R0672",
  "AGENT_R0673",
  "AGENT_R0674",
  "AGENT_R0675",
  "AGENT_R0676",
  "AGENT_R0677",
  "AGENT_R0678",
  "AGENT_R0679",
  "AGENT_R0680",
  "AGENT_R0681",
  "AGENT_R0682",
  "AGENT_R0683",
  "AGENT_R0684",
  "AGENT_R0685",
  "AGENT_R0686",
  "AGENT_R0687",
  "AGENT_R0688",
  "AGENT_R0689",
  "AGENT_R0690",
  "AGENT_R0691",
  "AGENT_R0692",
  "AGENT_R0693",
  "AGENT_R0694",
  "AGENT_R0695",
  "AGENT_R0696",
  "AGENT_R0697",
  "AGENT_R0698",
  "AGENT_R0700",
  "AGENT_R0701",
  "AGENT_R0702",
  "AGENT_R0703",
  "AGENT_R0704",
  "AGENT_R0705",
  "AGENT_R0706",
  "AGENT_R0707",
  "AGENT_R0708",
  "AGENT_R0709",
  "AGENT_R0710",
  "AGENT_R0711",
  "AGENT_R0713",
  "AGENT_R0714",
  "AGENT_R0715",
  "AGENT_R0716",
  "AGENT_R0718",
  "AGENT_R0719",
  "AGENT_R0721",
  "AGENT_R0722",
  "AGENT_R0723",
  "AGENT_R0725",
  "AGENT_R0727",
  "AGENT_R0728",
  "AGENT_R0729",
  "AGENT_R0730",
  "AGENT_R0731",
  "AGENT_R0732",
  "AGENT_R0733",
  "AGENT_R0734",
  "AGENT_R0735",
  "AGENT_R0736",
  "AGENT_R0737",
  "AGENT_R0738",
  "AGENT_R0739",
  "AGENT_R0740",
  "AGENT_R0741",
  "AGENT_R0744",
  "AGENT_R0745",
  "AGENT_R0746",
  "AGENT_R0747",
  "AGENT_R0768",
  "AGENT_R0769",
  "AGENT_R0770",
] as const

it("gives each Agent runtime code from AGENT_R0638 to AGENT_R0770 a fix and its own docs page", () => {
  for (const code of codes) {
    const error = agentDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports duplicate Agent Invoker Profile ids with a code and a fix", () => {
  expect(() => defineAgent({
    driver: { run: () => "ok" },
    invoker: { profiles: [{ id: "support", kind: "support", label: "Support" }, { id: "support", kind: "support", label: "Support" }] },
  })).toThrow(expect.objectContaining({
    code: "AGENT_R0640",
    fix: expect.stringContaining("defineAgent({ invoker: { profiles } })"),
  }))
})

it("reports createProcessAgentCapacity() without a positive concurrency with a code and a fix", () => {
  expect(() => createProcessAgentCapacity({ concurrency: 0 })).toThrow(expect.objectContaining({
    code: "AGENT_R0732",
    fix: expect.stringContaining("createProcessAgentCapacity({ concurrency })"),
  }))
})

it("reports defineAgentRunEvents() without a store with a code and a fix", () => {
  // SAFETY: The test passes an invalid value to check the runtime error.
  expect(() => defineAgentRunEvents({} as never)).toThrow(expect.objectContaining({
    code: "AGENT_R0730",
    fix: expect.stringContaining("defineAgentRunEvents()"),
  }))
})
