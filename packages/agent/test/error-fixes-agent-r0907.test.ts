import { expect, it } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { access } from "../src/capabilities/access.ts"
import { browser } from "../src/capabilities/browser.ts"
import { diagnostics } from "../src/capabilities/diagnostics.ts"
import { fetch } from "../src/capabilities/fetch.ts"

const codes = [
  "AGENT_R0907",
  "AGENT_R0908",
  "AGENT_R0909",
  "AGENT_R0910",
  "AGENT_R0911",
  "AGENT_R0912",
  "AGENT_R0913",
  "AGENT_R0914",
  "AGENT_R0915",
  "AGENT_R0916",
  "AGENT_R0917",
  "AGENT_R0918",
  "AGENT_R0919",
  "AGENT_R0920",
  "AGENT_R0921",
  "AGENT_R0905",
  "AGENT_R0906",
  "AGENT_R0903",
  "AGENT_R0904",
  "AGENT_R0898",
  "AGENT_R0899",
  "AGENT_R0900",
  "AGENT_R0901",
  "AGENT_R0902",
  "AGENT_R0890",
  "AGENT_R0891",
  "AGENT_R0893",
  "AGENT_R0894",
  "AGENT_R0895",
  "AGENT_R0896",
  "AGENT_R0897",
  "AGENT_R0004",
  "AGENT_R0005",
  "AGENT_R0006",
  "AGENT_R0007",
  "AGENT_R0008",
  "AGENT_R0009",
  "AGENT_R0010",
  "AGENT_R0011",
  "AGENT_R0012",
  "AGENT_R0013",
  "AGENT_R0014",
  "AGENT_R0015",
  "AGENT_R0016",
  "AGENT_R0017",
  "AGENT_R0018",
  "AGENT_R0019",
  "AGENT_R0020",
  "AGENT_R0021",
  "AGENT_R0022",
  "AGENT_R0023",
  "AGENT_R0024",
  "AGENT_R0025",
  "AGENT_R0026",
  "AGENT_R0027",
  "AGENT_R0028",
  "AGENT_R0029",
  "AGENT_R0030",
  "AGENT_R0031",
  "AGENT_R0032",
  "AGENT_R0033",
  "AGENT_R0034",
  "AGENT_R0035",
  "AGENT_R0036",
  "AGENT_R0037",
  "AGENT_R0049",
  "AGENT_R0050",
  "AGENT_R0051",
  "AGENT_R0052",
  "AGENT_R0053",
  "AGENT_R0054",
  "AGENT_R0055",
  "AGENT_R0056",
  "AGENT_R0057",
  "AGENT_R0058",
  "AGENT_R0059",
  "AGENT_R0060",
  "AGENT_R0061",
  "AGENT_R0062",
  "AGENT_R0063",
  "AGENT_R0064",
  "AGENT_R0065",
  "AGENT_R0066",
  "AGENT_R0067",
  "AGENT_R0068",
  "AGENT_R0069",
] as const

it("gives each Agent runtime code from AGENT_R0907 to AGENT_R0069 a fix and its own docs page", () => {
  for (const code of codes) {
    const error = agentDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports access() without an access surface with a code and a fix", () => {
  expect(() => access({} as never)).toThrow(expect.objectContaining({
    code: "AGENT_R0016",
    fix: expect.stringContaining("Pass chat, workspace, or both to access()"),
  }))
})

it("reports a browser() runtime that does not exist with a code and a fix", () => {
  expect(() => browser({ runtime: "remote" as never })).toThrow(expect.objectContaining({
    code: "AGENT_R0025",
    fix: expect.stringContaining("browser({ runtime })"),
  }))
})

it("reports a diagnostics() interval longer than its heartbeat with a code and a fix", () => {
  expect(() => diagnostics({ heartbeat: 1_000, interval: 5_000 })).toThrow(expect.objectContaining({
    code: "AGENT_R0030",
    fix: expect.stringContaining("diagnostics({ heartbeat })"),
  }))
})

it("reports fetch() without tools with a code and a fix", () => {
  expect(() => fetch({ tools: {} })).toThrow(expect.objectContaining({
    code: "AGENT_R0050",
    fix: expect.stringContaining("fetch({ tools })"),
  }))
})
