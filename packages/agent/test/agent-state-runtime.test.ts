import { readFile } from "node:fs/promises"

import { transform } from "esbuild"
import { Miniflare } from "miniflare"
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
    vi.stubGlobal("navigator", undefined)
    vi.stubGlobal("WebSocketPair", class WebSocketPair {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { opensLibsqlAgentState } = await load()

    expect(opensLibsqlAgentState("file:///app/.vitehub/data/agent-state.sqlite", { configured: false })).toBe(false)
    expect(opensLibsqlAgentState("file:///app/.vitehub/data/agent-state.sqlite", { configured: false })).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain("agent.providers.state.url")
  })

  it("throws for a file: URL that the app set in workerd", async () => {
    vi.stubGlobal("navigator", undefined)
    vi.stubGlobal("WebSocketPair", class WebSocketPair {})
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

  it("detects Miniflare even when the Worker disables navigator", async () => {
    const source = await readFile(new URL("../src/internal/workers-runtime.ts", import.meta.url), "utf8")
    const { code } = await transform(source, { loader: "ts", format: "esm" })
    const miniflare = new Miniflare({
      compatibilityDate: "2026-07-14",
      compatibilityFlags: ["nodejs_compat", "no_global_navigator"],
      modules: true,
      script: `${code}\nexport default { fetch() { return Response.json({ navigator: typeof navigator, worker: isWorkersRuntime() }) } }`,
    })
    try {
      const response = await miniflare.dispatchFetch("http://localhost")
      expect(await response.json()).toEqual({ navigator: "undefined", worker: true })
    } finally {
      await miniflare.dispose()
    }
  })
})
