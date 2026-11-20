import { afterEach, describe, expect, it, vi } from "vitest"

async function load() {
  vi.resetModules()
  return await import("../src/internal/agent-state-runtime.ts")
}

describe("opensLibsqlAgentState", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("runs without State for the local default file in workerd, and warns once", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { opensLibsqlAgentState } = await load()

    expect(opensLibsqlAgentState("file:///app/.vitehub/data/agent-state.sqlite", { configured: false })).toBe(false)
    expect(opensLibsqlAgentState("file:///app/.vitehub/data/agent-state.sqlite", { configured: false })).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain("VITEHUB_AGENT_STATE_URL")
  })

  it("throws for a file: URL that the app set in workerd", async () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" })
    const { opensLibsqlAgentState } = await load()

    expect(() => opensLibsqlAgentState("file:.data/state.db", { configured: true })).toThrow(expect.objectContaining({ code: "AGENT_STATE_FILE_URL_UNSUPPORTED" }))
  })

  it("opens a libSQL server URL in workerd and a file in Node", async () => {
    const { opensLibsqlAgentState } = await load()
    expect(opensLibsqlAgentState("file:.data/state.db", { configured: true })).toBe(true)

    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" })
    expect(opensLibsqlAgentState("libsql://state.example.turso.io", { configured: true })).toBe(true)
    expect(opensLibsqlAgentState("http://127.0.0.1:8080", { configured: false })).toBe(true)
  })
})
