import { describe, expect, it, vi } from "vitest"

import { encodeAgentRouteParam } from "../src/console/runtime/console-route.ts"
import { listConsoleInvocations } from "../src/console/runtime/server/invocations.get.ts"
import { agentConsole } from "../src/console/server.ts"
import { viteHubErrorDiagnostics } from "../src/error-diagnostics.ts"

/** The codes that the Console route, its operations, and the Console page can raise. */
const consoleCodes = [
  "VITE_HUB_B0001",
  "VITE_HUB_C0001",
  "VITE_HUB_C0002",
  "VITE_HUB_R0040",
  "VITE_HUB_R0041",
  "VITE_HUB_R0042",
  "VITE_HUB_R0043",
  "VITE_HUB_R0044",
  "VITE_HUB_R0045",
  "VITE_HUB_R0046",
  "VITE_HUB_R0047",
  "VITE_HUB_R0049",
  "VITE_HUB_R0050",
  "VITE_HUB_R0051",
  "VITE_HUB_R0052",
  "VITE_HUB_R0053",
  "VITE_HUB_R0054",
  "VITE_HUB_R0058",
  "VITE_HUB_R0059",
  "VITE_HUB_R0060",
  "VITE_HUB_R0061",
  "VITE_HUB_R0062",
  "VITE_HUB_R0063",
  "VITE_HUB_R0070",
  "VITE_HUB_R0071",
  "VITE_HUB_R0072",
  "VITE_HUB_R0073",
  "VITE_HUB_R0074",
  "VITE_HUB_R0095",
  "VITE_HUB_R0096",
  "VITE_HUB_R0097",
  "VITE_HUB_R0098",
  "VITE_HUB_R0101",
  "VITE_HUB_R0102",
  "VITE_HUB_R0103",
  "VITE_HUB_R0104",
  "VITE_HUB_R0106",
  "VITE_HUB_R0107",
  "VITE_HUB_R0108",
  "VITE_HUB_R0109",
  "VITE_HUB_R0113",
  "VITE_HUB_R0114",
  "VITE_HUB_R0115",
  "VITE_HUB_R0116",
  "VITE_HUB_R0117",
  "VITE_HUB_R0118",
] as const

const runtime: Parameters<typeof agentConsole.resolve>[0] = { memo: (_key, create) => create(), runtime: "unknown", waitUntil: vi.fn() }

describe("Console error fixes", () => {
  it.each(consoleCodes)("gives %s a fix and its own docs page", (code) => {
    const error = viteHubErrorDiagnostics[code]({ message: "m" })
    expect(error.fix).toMatch(/\S/)
    expect(error.docs).toBe(`https://vitehub.dev/docs/development/diagnostics/${code.toLowerCase()}`)
  })

  it("tells an Agent handler what invocationUrl() needs", () => {
    const links = agentConsole.resolve(runtime)
    expect(() => links.invocationUrl({ id: "ainv_1" })).toThrow(expect.objectContaining({
      code: "VITE_HUB_R0074",
      fix: expect.stringContaining("`agentName`"),
    }))
    expect(() => links.invocationUrl({ agentName: "support", id: "ainv_1" })).toThrow(expect.objectContaining({
      code: "VITE_HUB_R0073",
      fix: expect.stringContaining("vitehub({ publicUrl })"),
    }))
  })

  it("names the Agent folder for an Agent name that the Console cannot route", () => {
    expect(() => encodeAgentRouteParam(" support")).toThrow(expect.objectContaining({
      code: "VITE_HUB_R0045",
      fix: expect.stringContaining("server/agents/"),
    }))
  })

  it("answers every malformed invocations.list cursor with VITE_HUB_R0058 and its fix", async () => {
    for (const cursor of ["[]", "{}", "{\"done\":1}", "not json"]) {
      await expect(listConsoleInvocations({ cursor })).rejects.toMatchObject({
        code: "VITE_HUB_R0058",
        fix: expect.stringContaining("vitehub invocations list"),
        status: 400,
      })
    }
    await expect(listConsoleInvocations({ limit: 0 })).rejects.toMatchObject({
      code: "VITE_HUB_R0062",
      fix: expect.stringContaining("--limit"),
    })
  })
})
