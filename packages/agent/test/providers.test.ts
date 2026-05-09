import { describe, expect, it, vi } from "vitest"

describe("agent Vite plugin", () => {
  it("attaches Nitro and merges server noExternal", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent()

    expect(plugin.nitro).toBeTruthy()
    const hook = plugin.configEnvironment
    const result = typeof hook === "function"
      ? hook.call({} as never, "ssr", {
          consumer: "server",
          resolve: { noExternal: ["existing"] },
        } as never, {} as never)
      : undefined

    expect(result).toMatchObject({
      resolve: { noExternal: ["existing", "@vitehub/agent"] },
    })
  })

  it("exposes hubAgent options through Vite config", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ route: "/agents/[agent]" })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined

    expect(result).toEqual({ agent: { route: "/agents/[agent]" } })
  })
})

describe("Vercel helpers", () => {
  it("returns JSON responses for non-streaming agent calls", async () => {
    const { defineVercelAgentHandler } = await import("../src/vercel.ts")
    const waitUntil = vi.fn()
    const agent = {
      generate: vi.fn(async () => ({ finishReason: "stop", text: "ok", usage: { inputTokens: 1 } })),
      stream: vi.fn(),
      tools: {},
      version: "agent-v1",
    }
    const handler = defineVercelAgentHandler(agent as never, { waitUntil })

    const response = await handler(new Request("https://example.com/agents/triager", {
      body: JSON.stringify({ prompt: "hello", stream: false }),
      method: "POST",
    }))

    await expect(response.json()).resolves.toMatchObject({ text: "ok" })
    expect(agent.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: "hello" }))
  })
})

describe("agent registry helpers", () => {
  it("resolves named agents from a registry", async () => {
    const { getAgentFromRegistry } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(),
      stream: vi.fn(),
      tools: {},
      version: "agent-v1",
    }

    await expect(getAgentFromRegistry("triager", {} as never, {
      triager: async () => ({ default: agent as never }),
    })).resolves.toBe(agent)
  })

  it("throws clearly for unknown named agents", async () => {
    const { getAgentFromRegistry } = await import("../src/index.ts")

    await expect(getAgentFromRegistry("missing", {} as never, {})).rejects.toThrow("Unknown agent: missing")
  })
})
