import { expect, it } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { channelAdapter, telegram } from "../src/channels.ts"

const codes = [
  "AGENT_R0315",
  "AGENT_R0316",
  "AGENT_R0317",
  "AGENT_R0318",
  "AGENT_R0319",
  "AGENT_R0321",
  "AGENT_R0322",
  "AGENT_R0323",
  "AGENT_R0324",
  "AGENT_R0325",
  "AGENT_R0326",
  "AGENT_R0327",
  "AGENT_R0328",
  "AGENT_R0329",
  "AGENT_R0330",
  "AGENT_R0331",
  "AGENT_R0332",
  "AGENT_R0333",
  "AGENT_R0334",
  "AGENT_R0335",
  "AGENT_R0336",
  "AGENT_R0337",
  "AGENT_R0338",
  "AGENT_R0339",
  "AGENT_R0340",
  "AGENT_R0341",
  "AGENT_R0342",
  "AGENT_R0343",
  "AGENT_R0344",
  "AGENT_R0345",
  "AGENT_R0346",
  "AGENT_R0347",
  "AGENT_R0348",
  "AGENT_R0349",
  "AGENT_R0350",
  "AGENT_R0351",
  "AGENT_R0352",
  "AGENT_R0353",
  "AGENT_R0354",
  "AGENT_R0355",
  "AGENT_R0356",
  "AGENT_R0357",
  "AGENT_R0358",
  "AGENT_R0359",
  "AGENT_R0360",
  "AGENT_R0361",
  "AGENT_R0362",
  "AGENT_R0363",
  "AGENT_R0364",
  "AGENT_R0365",
  "AGENT_R0366",
  "AGENT_R0367",
  "AGENT_R0368",
  "AGENT_R0369",
  "AGENT_R0370",
  "AGENT_R0371",
  "AGENT_R0373",
  "AGENT_R0374",
  "AGENT_R0375",
  "AGENT_R0376",
  "AGENT_R0377",
  "AGENT_R0378",
  "AGENT_R0379",
  "AGENT_R0380",
  "AGENT_R0381",
  "AGENT_R0382",
  "AGENT_R0383",
  "AGENT_R0384",
  "AGENT_R0385",
  "AGENT_R0386",
  "AGENT_R0387",
  "AGENT_R0388",
  "AGENT_R0389",
  "AGENT_R0390",
  "AGENT_R0391",
  "AGENT_R0392",
  "AGENT_R0393",
  "AGENT_R0394",
  "AGENT_R0395",
  "AGENT_R0396",
  "AGENT_R0397",
  "AGENT_R0398",
  "AGENT_R0399",
  "AGENT_R0400",
  "AGENT_R0401",
  "AGENT_R0402",
  "AGENT_R0403",
  "AGENT_R0404",
  "AGENT_R0406",
  "AGENT_R0407",
  "AGENT_R0408",
  "AGENT_R0409",
  "AGENT_R0410",
  "AGENT_R0411",
  "AGENT_R0412",
  "AGENT_R0421",
] as const

it("gives each Agent runtime code from AGENT_R0315 to AGENT_R0421 a fix and its own docs page", () => {
  for (const code of codes) {
    const error = agentDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports telegram() with webhookSecret and webhooks with a code and a fix", () => {
  expect(() => telegram({ webhookSecret: "secret", webhooks: true } as never)).toThrow(expect.objectContaining({
    code: "AGENT_R0373",
    fix: expect.stringContaining("webhookSecret or webhooks"),
  }))
})

it("reports channelAdapter() without a kind with a code and a fix", () => {
  expect(() => channelAdapter(" " as never)).toThrow(expect.objectContaining({
    code: "AGENT_R0371",
    fix: expect.stringContaining("channelAdapter()"),
  }))
})
