import { expect, it } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { defineAgent } from "../src/index.ts"

const codes = [
  "AGENT_R0422",
  "AGENT_R0423",
  "AGENT_R0424",
  "AGENT_R0425",
  "AGENT_R0426",
  "AGENT_R0427",
  "AGENT_R0428",
  "AGENT_R0429",
  "AGENT_R0430",
  "AGENT_R0431",
  "AGENT_R0434",
  "AGENT_R0435",
  "AGENT_R0438",
  "AGENT_R0439",
  "AGENT_R0440",
  "AGENT_R0441",
  "AGENT_R0442",
  "AGENT_R0443",
  "AGENT_R0444",
  "AGENT_R0446",
  "AGENT_R0447",
  "AGENT_R0450",
  "AGENT_R0451",
  "AGENT_R0452",
  "AGENT_R0453",
  "AGENT_R0454",
  "AGENT_R0455",
  "AGENT_R0456",
  "AGENT_R0457",
  "AGENT_R0458",
  "AGENT_R0459",
  "AGENT_R0460",
  "AGENT_R0461",
  "AGENT_R0462",
  "AGENT_R0463",
  "AGENT_R0464",
  "AGENT_R0465",
  "AGENT_R0466",
  "AGENT_R0467",
  "AGENT_R0468",
  "AGENT_R0469",
  "AGENT_R0470",
  "AGENT_R0471",
  "AGENT_R0472",
  "AGENT_R0473",
  "AGENT_R0474",
  "AGENT_R0475",
  "AGENT_R0476",
  "AGENT_R0477",
  "AGENT_R0478",
  "AGENT_R0479",
  "AGENT_R0480",
  "AGENT_R0481",
  "AGENT_R0482",
  "AGENT_R0483",
  "AGENT_R0484",
  "AGENT_R0485",
  "AGENT_R0486",
  "AGENT_R0487",
  "AGENT_R0488",
  "AGENT_R0489",
  "AGENT_R0490",
  "AGENT_R0491",
  "AGENT_R0492",
  "AGENT_R0493",
  "AGENT_R0494",
  "AGENT_R0495",
  "AGENT_R0496",
  "AGENT_R0497",
  "AGENT_R0498",
  "AGENT_R0499",
  "AGENT_R0500",
  "AGENT_R0501",
  "AGENT_R0502",
  "AGENT_R0503",
  "AGENT_R0504",
  "AGENT_R0505",
  "AGENT_R0506",
  "AGENT_R0507",
  "AGENT_R0508",
  "AGENT_R0509",
  "AGENT_R0510",
  "AGENT_R0511",
  "AGENT_R0512",
  "AGENT_R0513",
  "AGENT_R0514",
  "AGENT_R0516",
  "AGENT_R0517",
  "AGENT_R0518",
  "AGENT_R0519",
  "AGENT_R0520",
] as const

it("gives each Agent runtime code from AGENT_R0422 to AGENT_R0520 a fix and its own docs page", () => {
  for (const code of codes) {
    const error = agentDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports an Agent name longer than 512 characters with a code and a fix", () => {
  expect(() => defineAgent({ name: "a".repeat(513), driver: { run: () => "ok" } })).toThrow(expect.objectContaining({
    code: "AGENT_R0430",
    fix: expect.stringContaining("defineAgent({ name })"),
  }))
})

it("reports a driver with both model and run with a code and a fix", () => {
  expect(() => defineAgent({ driver: { model: "openai/gpt-5.1-mini", run: () => "ok" } as never })).toThrow(expect.objectContaining({
    code: "AGENT_R0493",
    fix: expect.stringContaining("driver.model, driver.run, or driver.ask"),
  }))
})

it("reports a driver capacity without a positive concurrency with a code and a fix", () => {
  expect(() => defineAgent({ driver: { run: () => "ok", capacity: { concurrency: 0 } } as never })).toThrow(expect.objectContaining({
    code: "AGENT_R0456",
    fix: expect.stringContaining("driver.capacity.concurrency"),
  }))
})
