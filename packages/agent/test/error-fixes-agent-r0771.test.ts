import { expect, it } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { createCloudflareAgentState } from "../src/state/providers/cloudflare.ts"
import { createLibsqlAgentState, createSqliteAgentState } from "../src/state/sqlite.ts"

const codes = [
  "AGENT_R0771",
  "AGENT_R0772",
  "AGENT_R0773",
  "AGENT_R0774",
  "AGENT_R0775",
  "AGENT_R0776",
  "AGENT_R0777",
  "AGENT_R0778",
  "AGENT_R0779",
  "AGENT_R0780",
  "AGENT_R0781",
  "AGENT_R0782",
  "AGENT_R0783",
  "AGENT_R0787",
  "AGENT_R0788",
  "AGENT_R0790",
  "AGENT_R0791",
  "AGENT_R0792",
  "AGENT_R0793",
  "AGENT_R0794",
  "AGENT_R0795",
  "AGENT_R0796",
  "AGENT_R0797",
  "AGENT_R0798",
  "AGENT_R0799",
  "AGENT_R0801",
  "AGENT_R0802",
  "AGENT_R0803",
  "AGENT_R0804",
  "AGENT_R0805",
  "AGENT_R0806",
  "AGENT_R0807",
  "AGENT_R0808",
  "AGENT_R0809",
  "AGENT_R0810",
  "AGENT_R0811",
  "AGENT_R0812",
  "AGENT_R0813",
  "AGENT_R0814",
  "AGENT_R0815",
  "AGENT_R0816",
  "AGENT_R0817",
  "AGENT_R0818",
  "AGENT_R0819",
  "AGENT_R0820",
  "AGENT_R0821",
  "AGENT_R0822",
  "AGENT_R0823",
  "AGENT_R0824",
  "AGENT_R0825",
  "AGENT_R0826",
  "AGENT_R0827",
  "AGENT_R0828",
  "AGENT_R0829",
  "AGENT_R0830",
  "AGENT_R0831",
  "AGENT_R0832",
  "AGENT_R0833",
  "AGENT_R0834",
  "AGENT_R0835",
  "AGENT_R0836",
  "AGENT_R0837",
  "AGENT_R0839",
  "AGENT_R0840",
  "AGENT_R0841",
  "AGENT_R0843",
  "AGENT_R0844",
  "AGENT_R0845",
  "AGENT_R0846",
  "AGENT_R0847",
  "AGENT_R0848",
  "AGENT_R0849",
  "AGENT_R0850",
  "AGENT_R0851",
  "AGENT_R0852",
  "AGENT_R0853",
  "AGENT_R0854",
  "AGENT_R0855",
  "AGENT_R0858",
  "AGENT_R0859",
  "AGENT_R0860",
  "AGENT_R0861",
  "AGENT_R0862",
  "AGENT_R0863",
  "AGENT_R0864",
  "AGENT_R0865",
  "AGENT_R0866",
  "AGENT_R0867",
  "AGENT_R0868",
  "AGENT_R0869",
] as const

it("gives each Agent runtime code from AGENT_R0771 to AGENT_R0869 a fix and its own docs page", () => {
  for (const code of codes) {
    const error = agentDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports createLibsqlAgentState() without url or client with a code and a fix", () => {
  expect(() => createLibsqlAgentState({})).toThrow(expect.objectContaining({
    code: "AGENT_R0852",
    fix: expect.stringContaining("createLibsqlAgentState()"),
  }))
})

it("reports createSqliteAgentState() without a driver with a code and a fix", () => {
  // SAFETY: The test passes an invalid value to check the runtime error.
  expect(() => createSqliteAgentState({} as never)).toThrow(expect.objectContaining({
    code: "AGENT_R0850",
    fix: expect.stringContaining("driver"),
  }))
})

it("reports createCloudflareAgentState() without its Durable Object binding with a code and a fix", () => {
  // SAFETY: The test passes an invalid value to check the runtime error.
  expect(() => createCloudflareAgentState({} as never)).toThrow(expect.objectContaining({
    code: "AGENT_R0847",
    fix: expect.stringContaining("CHAT_STATE"),
  }))
})
