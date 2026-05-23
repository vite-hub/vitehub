import { describe, expect, it, vi } from "vitest"

import { resolveAgentCapabilities } from "../src/capability-runtime.ts"
import { webSearch } from "../src/capabilities.ts"
import { resolveWebSearchProvider } from "../src/capabilities/web-search/credentials.ts"

function runtime() {
  return {
    capabilities: {},
    memo: vi.fn(),
    runtime: "unknown" as const,
    runtimeConfig: {},
    waitUntil: vi.fn(),
  }
}

describe("webSearch capability", () => {
  it("requires an explicit mode", () => {
    expect(() => webSearch({} as never)).toThrow("mode must be")
  })

  it("adds search and read tools in tool mode", async () => {
    const resolved = await resolveAgentCapabilities({
      capabilities: [webSearch({ mode: "tool", provider: "exa" })],
    }, runtime(), {})

    expect(Object.keys(resolved.tools || {}).sort()).toEqual(["web_read", "web_search"])
    expect(resolved.tools?.web_read.name).toBe("web_read")
    expect(resolved.tools?.web_search.name).toBe("web_search")
  })

  it("resolves tool-mode credentials in documented order", () => {
    const previous = process.env.VITEHUB_EXA_API_KEY
    process.env.VITEHUB_EXA_API_KEY = "vitehub-exa-key"

    try {
      expect(resolveWebSearchProvider("exa")).toMatchObject({
        apiKey: "vitehub-exa-key",
        name: "exa",
      })
    }
    finally {
      if (previous === undefined) delete process.env.VITEHUB_EXA_API_KEY
      else process.env.VITEHUB_EXA_API_KEY = previous
    }
  })

  it("prefers explicit Secret Env credentials over env vars", () => {
    const previous = process.env.VITEHUB_TAVILY_API_KEY
    process.env.VITEHUB_TAVILY_API_KEY = "env-key"

    try {
      expect(resolveWebSearchProvider({
        apiKey: { unseal: () => "secret-key" },
        name: "tavily",
      })).toMatchObject({
        apiKey: "secret-key",
        name: "tavily",
      })
    }
    finally {
      if (previous === undefined) delete process.env.VITEHUB_TAVILY_API_KEY
      else process.env.VITEHUB_TAVILY_API_KEY = previous
    }
  })

  it("fails clearly for unsupported tool input options", async () => {
    const resolved = await resolveAgentCapabilities({
      capabilities: [webSearch({ mode: "tool", provider: "exa" })],
    }, runtime(), {})

    await expect(resolved.tools?.web_search.execute?.({
      query: "vitehub",
      rawHtml: true,
    })).rejects.toThrow("does not support option")
  })

  it("contributes model mode as an adapter-owned provider tool", async () => {
    const resolved = await resolveAgentCapabilities({
      capabilities: [webSearch({ mode: "model" })],
    }, runtime(), {})

    expect(resolved.tools).toBeUndefined()
    expect(resolved.registries.providerTools).toEqual([{
      args: {},
      id: "openai.web_search",
      name: "web_search",
    }])
  })
})
