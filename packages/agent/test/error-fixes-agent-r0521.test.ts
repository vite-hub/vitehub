import { expect, it } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

const codes = [
  "AGENT_R0521",
  "AGENT_R0522",
  "AGENT_R0523",
  "AGENT_R0524",
  "AGENT_R0525",
  "AGENT_R0526",
  "AGENT_R0527",
  "AGENT_R0528",
  "AGENT_R0529",
  "AGENT_R0530",
  "AGENT_R0531",
  "AGENT_R0532",
  "AGENT_R0533",
  "AGENT_R0534",
  "AGENT_R0535",
  "AGENT_R0536",
  "AGENT_R0537",
  "AGENT_R0538",
  "AGENT_R0539",
  "AGENT_R0540",
  "AGENT_R0541",
  "AGENT_R0542",
  "AGENT_R0543",
  "AGENT_R0544",
  "AGENT_R0545",
  "AGENT_R0546",
  "AGENT_R0547",
  "AGENT_R0548",
  "AGENT_R0549",
  "AGENT_R0550",
  "AGENT_R0551",
  "AGENT_R0552",
  "AGENT_R0553",
  "AGENT_R0554",
  "AGENT_R0555",
  "AGENT_R0556",
  "AGENT_R0557",
  "AGENT_R0558",
  "AGENT_R0559",
  "AGENT_R0560",
  "AGENT_R0561",
  "AGENT_R0562",
  "AGENT_R0563",
  "AGENT_R0564",
  "AGENT_R0565",
  "AGENT_R0566",
  "AGENT_R0567",
  "AGENT_R0569",
  "AGENT_R0570",
  "AGENT_R0571",
  "AGENT_R0582",
  "AGENT_R0583",
  "AGENT_R0584",
  "AGENT_R0585",
  "AGENT_R0586",
  "AGENT_R0587",
  "AGENT_R0588",
  "AGENT_R0589",
  "AGENT_R0590",
  "AGENT_R0591",
  "AGENT_R0593",
  "AGENT_R0594",
  "AGENT_R0595",
  "AGENT_R0596",
  "AGENT_R0597",
  "AGENT_R0598",
  "AGENT_R0599",
  "AGENT_R0601",
  "AGENT_R0604",
  "AGENT_R0605",
  "AGENT_R0606",
  "AGENT_R0607",
  "AGENT_R0608",
  "AGENT_R0618",
  "AGENT_R0619",
  "AGENT_R0620",
  "AGENT_R0621",
  "AGENT_R0622",
  "AGENT_R0623",
  "AGENT_R0624",
  "AGENT_R0625",
  "AGENT_R0626",
  "AGENT_R0627",
  "AGENT_R0628",
  "AGENT_R0629",
  "AGENT_R0630",
  "AGENT_R0631",
  "AGENT_R0632",
  "AGENT_R0633",
  "AGENT_R0634",
  "AGENT_R0635",
  "AGENT_R0636",
  "AGENT_R0637",
] as const

it("gives each Agent runtime code from AGENT_R0521 to AGENT_R0637 a fix and its own docs page", () => {
  for (const code of codes) {
    const error = agentDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports defineAgentInvocations() with an invalid storeTimeoutMs with a code and a fix", () => {
  expect(() => defineAgentInvocations({ storeTimeoutMs: 0, store: createMemoryAgentInvocationStore() })).toThrow(expect.objectContaining({
    code: "AGENT_R0624",
    fix: expect.stringContaining("storeTimeoutMs"),
  }))
})

it("reports a SQLite Agent Invocation store without url or client with a code and a fix", () => {
  expect(() => createLibsqlAgentInvocationStore({})).toThrow(expect.objectContaining({
    code: "AGENT_R0633",
    fix: expect.stringContaining("url or a client"),
  }))
})

it("reports an Agent Invocation list() limit of 0 with a code and a fix", async () => {
  const store = createMemoryAgentInvocationStore()
  await expect((async () => await store.list({ limit: 0 }))()).rejects.toMatchObject({
    code: "AGENT_R0618",
    fix: expect.stringContaining("limit"),
  })
})
