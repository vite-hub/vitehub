import { expect, it } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { createTranscription } from "../src/capabilities/transcription.ts"
import { elevenLabsScribe } from "../src/capabilities/transcription-elevenlabs.ts"
import { webSearch } from "../src/capabilities/web-search/index.ts"
import { workspaceShell } from "../src/capabilities/workspace-shell.ts"

const codes = [
  "AGENT_R0204",
  "AGENT_R0205",
  "AGENT_R0206",
  "AGENT_R0207",
  "AGENT_R0208",
  "AGENT_R0209",
  "AGENT_R0210",
  "AGENT_R0211",
  "AGENT_R0212",
  "AGENT_R0213",
  "AGENT_R0214",
  "AGENT_R0215",
  "AGENT_R0216",
  "AGENT_R0217",
  "AGENT_R0218",
  "AGENT_R0219",
  "AGENT_R0220",
  "AGENT_R0221",
  "AGENT_R0222",
  "AGENT_R0223",
  "AGENT_R0224",
  "AGENT_R0225",
  "AGENT_R0229",
  "AGENT_R0230",
  "AGENT_R0231",
  "AGENT_R0232",
  "AGENT_R0233",
  "AGENT_R0234",
  "AGENT_R0235",
  "AGENT_R0236",
  "AGENT_R0237",
  "AGENT_R0238",
  "AGENT_R0239",
  "AGENT_R0240",
  "AGENT_R0241",
  "AGENT_R0242",
  "AGENT_R0243",
  "AGENT_R0244",
  "AGENT_R0245",
  "AGENT_R0246",
  "AGENT_R0256",
  "AGENT_R0257",
  "AGENT_R0258",
  "AGENT_R0259",
  "AGENT_R0260",
  "AGENT_R0261",
  "AGENT_R0262",
  "AGENT_R0263",
  "AGENT_R0264",
  "AGENT_R0265",
  "AGENT_R0266",
  "AGENT_R0267",
  "AGENT_R0268",
  "AGENT_R0269",
  "AGENT_R0270",
  "AGENT_R0271",
  "AGENT_R0272",
  "AGENT_R0273",
  "AGENT_R0274",
  "AGENT_R0275",
  "AGENT_R0276",
  "AGENT_R0277",
  "AGENT_R0278",
  "AGENT_R0279",
  "AGENT_R0280",
  "AGENT_R0281",
  "AGENT_R0282",
  "AGENT_R0283",
  "AGENT_R0284",
  "AGENT_R0285",
  "AGENT_R0286",
  "AGENT_R0287",
  "AGENT_R0288",
  "AGENT_R0289",
  "AGENT_R0290",
  "AGENT_R0291",
  "AGENT_R0292",
  "AGENT_R0293",
  "AGENT_R0294",
  "AGENT_R0295",
  "AGENT_R0296",
  "AGENT_R0297",
  "AGENT_R0298",
  "AGENT_R0299",
  "AGENT_R0300",
  "AGENT_R0301",
  "AGENT_R0302",
  "AGENT_R0303",
  "AGENT_R0304",
  "AGENT_R0305",
  "AGENT_R0306",
  "AGENT_R0307",
  "AGENT_R0308",
  "AGENT_R0309",
  "AGENT_R0310",
  "AGENT_R0311",
  "AGENT_R0312",
  "AGENT_R0313",
  "AGENT_R0314",
] as const

it("gives each Agent runtime code from AGENT_R0204 to AGENT_R0314 a fix and its own docs page", () => {
  for (const code of codes) {
    const error = agentDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports an unknown webSearch() mode with a code and a fix", () => {
  expect(() => webSearch({ mode: "browser" } as never)).toThrow(expect.objectContaining({
    code: "AGENT_R0271",
    fix: expect.stringContaining("webSearch({ mode })"),
  }))
})

it("reports workspaceShell() commands without write mode with a code and a fix", () => {
  expect(() => workspaceShell({ commands: ["pnpm"] })).toThrow(expect.objectContaining({
    code: "AGENT_R0297",
    fix: expect.stringContaining("workspaceShell({ mode: \"write\" })"),
  }))
})

it("reports elevenLabsScribe() without an API key with a code and a fix", () => {
  expect(() => elevenLabsScribe({ webhookId: "hook" } as never)).toThrow(expect.objectContaining({
    code: "AGENT_R0245",
    fix: expect.stringContaining("elevenLabsScribe({ apiKey })"),
  }))
})

it("reports a transcription driver without receive() with a code and a fix", () => {
  expect(() => createTranscription({ driver: { name: "fixture", submit: async () => ({ id: "job" }) } as never })).toThrow(expect.objectContaining({
    code: "AGENT_R0260",
    fix: expect.stringContaining("receive()"),
  }))
})
