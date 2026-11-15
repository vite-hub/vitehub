import { expect, it } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { inputCommands } from "../src/capabilities/input-commands.ts"
import { mcp } from "../src/capabilities/mcp.ts"
import { otlp } from "../src/capabilities/otlp.ts"
import { sandbox } from "../src/capabilities/sandbox.ts"

const codes = [
  "AGENT_R0070",
  "AGENT_R0071",
  "AGENT_R0072",
  "AGENT_R0073",
  "AGENT_R0074",
  "AGENT_R0075",
  "AGENT_R0076",
  "AGENT_R0077",
  "AGENT_R0078",
  "AGENT_R0079",
  "AGENT_R0080",
  "AGENT_R0082",
  "AGENT_R0083",
  "AGENT_R0084",
  "AGENT_R0087",
  "AGENT_R0089",
  "AGENT_R0090",
  "AGENT_R0091",
  "AGENT_R0092",
  "AGENT_R0093",
  "AGENT_R0095",
  "AGENT_R0096",
  "AGENT_R0097",
  "AGENT_R0098",
  "AGENT_R0099",
  "AGENT_R0100",
  "AGENT_R0101",
  "AGENT_R0102",
  "AGENT_R0103",
  "AGENT_R0104",
  "AGENT_R0114",
  "AGENT_R0115",
  "AGENT_R0116",
  "AGENT_R0117",
  "AGENT_R0118",
  "AGENT_R0119",
  "AGENT_R0120",
  "AGENT_R0121",
  "AGENT_R0122",
  "AGENT_R0123",
  "AGENT_R0124",
  "AGENT_R0125",
  "AGENT_R0126",
  "AGENT_R0127",
  "AGENT_R0128",
  "AGENT_R0129",
  "AGENT_R0130",
  "AGENT_R0131",
  "AGENT_R0132",
  "AGENT_R0133",
  "AGENT_R0134",
  "AGENT_R0135",
  "AGENT_R0136",
  "AGENT_R0137",
  "AGENT_R0138",
  "AGENT_R0139",
  "AGENT_R0140",
  "AGENT_R0141",
  "AGENT_R0142",
  "AGENT_R0143",
  "AGENT_R0144",
  "AGENT_R0145",
  "AGENT_R0146",
  "AGENT_R0147",
  "AGENT_R0148",
  "AGENT_R0149",
  "AGENT_R0150",
  "AGENT_R0152",
  "AGENT_R0156",
  "AGENT_R0157",
  "AGENT_R0158",
  "AGENT_R0159",
  "AGENT_R0160",
  "AGENT_R0161",
  "AGENT_R0162",
  "AGENT_R0163",
  "AGENT_R0164",
  "AGENT_R0165",
  "AGENT_R0166",
  "AGENT_R0167",
  "AGENT_R0168",
  "AGENT_R0198",
  "AGENT_R0199",
  "AGENT_R0200",
  "AGENT_R0201",
  "AGENT_R0202",
  "AGENT_R0203",
] as const

it("gives each Agent runtime code from AGENT_R0070 to AGENT_R0203 a fix and its own docs page", () => {
  for (const code of codes) {
    const error = agentDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports an inputCommands() trigger with whitespace with a code and a fix", () => {
  expect(() => inputCommands({ commands: {}, trigger: "/ " })).toThrow(expect.objectContaining({
    code: "AGENT_R0102",
    fix: expect.stringContaining("inputCommands({ trigger })"),
  }))
})

it("reports mcp() without servers with a code and a fix", () => {
  expect(() => mcp({} as never)).toThrow(expect.objectContaining({
    code: "AGENT_R0117",
    fix: expect.stringContaining("mcp({ servers })"),
  }))
})

it("reports an otlp() endpoint that is not http or https with a code and a fix", () => {
  expect(() => otlp({ endpoint: "ftp://otel.example.com" })).toThrow(expect.objectContaining({
    code: "AGENT_R0152",
    fix: expect.stringContaining("otlp({ endpoint })"),
  }))
})

it("reports sandbox() without commands with a code and a fix", () => {
  expect(() => sandbox({ commands: [] })).toThrow(expect.objectContaining({
    code: "AGENT_R0164",
    fix: expect.stringContaining("sandbox({ commands })"),
  }))
})
