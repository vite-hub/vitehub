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
    const plugin = hubAgent({ route: true })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined

    expect(result).toEqual({ agent: { route: true } })
  })
})

describe("Vercel helpers", () => {
  it("returns JSON responses for non-streaming agent calls", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineVercelAgentHandler } = await import("../src/vercel.ts")
    const waitUntil = vi.fn()
    const run = vi.fn(() => ({ raw: { answer: 42 }, text: "ok" }))
    const agent = defineAgent({ run })
    const handler = defineVercelAgentHandler(agent as never, { waitUntil })

    const response = await handler(new Request("https://example.com/agents/triager", {
      body: JSON.stringify({ prompt: "hello", stream: false }),
      method: "POST",
    }))

    await expect(response.json()).resolves.toMatchObject({ raw: { answer: 42 }, text: "ok" })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ prompt: "hello" }),
    }))
  })

  it("keeps context.request readable for custom run agents", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineVercelAgentHandler } = await import("../src/vercel.ts")
    const run = vi.fn(async ({ request }) => ({
      text: (await request!.json()).prompt,
    }))
    const handler = defineVercelAgentHandler(defineAgent({ run }) as never, { waitUntil: vi.fn() })

    const response = await handler(new Request("https://example.com/agents/triager", {
      body: JSON.stringify({ prompt: "still readable", stream: false }),
      method: "POST",
    }))

    await expect(response.json()).resolves.toMatchObject({ text: "still readable" })
  })
})

describe("Cloudflare helpers", () => {
  it("keeps context.request readable for custom run agents", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineCloudflareAgentHandler } = await import("../src/cloudflare.ts")
    const run = vi.fn(async ({ request }) => ({
      text: (await request!.json()).prompt,
    }))
    const handler = defineCloudflareAgentHandler(defineAgent({ run }) as never)

    const response = await handler(new Request("https://example.com/agents/triager", {
      body: JSON.stringify({ prompt: "still readable", stream: false }),
      method: "POST",
    }), {}, { waitUntil: vi.fn() })

    await expect(response.json()).resolves.toMatchObject({ text: "still readable" })
  })
})

describe("Nitro helpers", () => {
  it("runs custom run agents without resolving a model first", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentHandler } = await import("../src/nitro.ts")
    const run = vi.fn(() => ({ raw: { routed: true }, text: "ok" }))
    const handler = defineAgentHandler(defineAgent({ run }) as never)
    const event = {
      req: {
        headers: { host: "example.com" },
        method: "POST",
        url: "/agents/triager",
      },
      url: "https://example.com/agents/triager",
      waitUntil: vi.fn(),
    }

    const result = await handler(event as never)

    expect(result).toMatchObject({ raw: { routed: true }, text: "ok" })
    expect(run).toHaveBeenCalled()
  })

  it("does not resolve custom run agents for resolved lifecycle hooks", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentHandler } = await import("../src/nitro.ts")
    const run = vi.fn(() => ({ raw: { routed: true }, text: "ok" }))
    const resolved = vi.fn()
    const handler = defineAgentHandler(defineAgent({ run }) as never, {
      lifecycleHooks: { resolved },
    })
    const event = {
      req: {
        headers: { host: "example.com" },
        method: "POST",
        url: "/agents/triager",
      },
      url: "https://example.com/agents/triager",
      waitUntil: vi.fn(),
    }

    const result = await handler(event as never)

    expect(result).toMatchObject({ raw: { routed: true }, text: "ok" })
    expect(run).toHaveBeenCalled()
    expect(resolved).not.toHaveBeenCalled()
  })

  it("keeps context.request readable for custom run agents", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentHandler } = await import("../src/nitro.ts")
    const run = vi.fn(async ({ request }) => ({
      text: (await request!.json()).prompt,
    }))
    const handler = defineAgentHandler(defineAgent({ run }) as never)
    const request = new Request("https://example.com/agents/triager", {
      body: JSON.stringify({ prompt: "still readable", stream: false }),
      method: "POST",
    })
    const event = {
      req: request,
      url: "https://example.com/agents/triager",
      waitUntil: vi.fn(),
    }

    const result = await handler(event as never)

    expect(result).toMatchObject({ text: "still readable" })
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

    await expect(getAgentFromRegistry("triage", {} as never, {
      reviewer: async () => ({} as never),
      triager: async () => ({} as never),
    })).rejects.toThrow("Unknown agent: triage. Did you mean \"triager\"? Discovered agents: reviewer, triager.")
  })
})
