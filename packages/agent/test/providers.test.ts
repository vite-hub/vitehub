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

  it("registers chat devtools handler from the agent chat runtime", async () => {
    const { hubChatDevtools } = await import("../src/vite.ts")
    const plugin = hubChatDevtools()
    const nitro = {
      options: {
        dev: true,
        handlers: [] as Array<{ handler: string, method?: string, route: string }>,
      },
    }

    await plugin.nitro.setup?.(nitro as never)

    expect(nitro.options.handlers[0]).toMatchObject({
      method: "POST",
    })
    expect(nitro.options.handlers[0]?.handler).toContain("/chat/runtime/chat-devtools-handler")
    expect(nitro.options.handlers[0]?.handler).not.toContain("/runtime/agent/chat-devtools-handler")
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

  it("exports the chat webhook handler used by chat capability route metadata", async () => {
    const { defineAgentChatRegistryHandler, defineAgentChatWebhookHandler } = await import("../src/nitro.ts")

    expect(defineAgentChatWebhookHandler).toBe(defineAgentChatRegistryHandler)
  })

  it("requires an explicit workspace for chat history webhooks", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { chat } = await import("../src/capabilities.ts")
    const { defineAgentChatRegistryHandler } = await import("../src/nitro.ts")
    const agent = defineAgent({
      capabilities: [chat({ adapters: {}, history: { source: "thread" } })],
      run: vi.fn(() => ({ text: "ok" })),
    })
    const handler = defineAgentChatRegistryHandler({
      support: async () => ({ default: agent as never }),
    })
    const request = new Request("https://example.com/agents/support/chat/slack", { method: "POST" })
    const event = {
      context: { params: { agent: "support", platform: "slack" } },
      req: request,
      url: "https://example.com/agents/support/chat/slack",
      waitUntil: vi.fn(),
    }

    await expect(handler(event as never)).rejects.toMatchObject({
      statusCode: 500,
      statusMessage: "chat({ history }) requires an agent workspace.",
    })
  })

  it("resolves chat history workspace from workspace agent defaults", async () => {
    await vi.resetModules()
    const useWorkspace = vi.fn(() => ({ fs: {}, tools: {} }))
    vi.doMock("@vitehub/workspace", () => ({ useWorkspace }))
    vi.doMock("../src/chat/runtime/agent-chat.ts", () => ({
      createChatBot: vi.fn(async () => ({
        webhooks: {
          slack: async () => ({ ok: true }),
        },
      })),
    }))

    try {
      const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
      const { chat } = await import("../src/capabilities.ts")
      const { defineAgentChatRegistryHandler } = await import("../src/nitro.ts")
      const agent = withWorkspaceAgentDefaults(defineAgent({
        capabilities: [chat({ adapters: {}, history: { source: "thread" } })],
        model: {} as never,
        provider: "ai-sdk",
        workspace: {},
      }), { name: "support-workspace" })
      const handler = defineAgentChatRegistryHandler({
        support: async () => ({ default: agent as never }),
      })
      const event = {
        context: { params: { agent: "support", platform: "slack" } },
        req: new Request("https://example.com/agents/support/chat/slack", { method: "POST" }),
        url: "https://example.com/agents/support/chat/slack",
        waitUntil: vi.fn(),
      }

      await expect(handler(event as never)).resolves.toEqual({ ok: true })
      expect(useWorkspace).toHaveBeenCalledWith("support-workspace", { allowWrite: true })
    }
    finally {
      vi.doUnmock("@vitehub/workspace")
      vi.doUnmock("../src/chat/runtime/agent-chat.ts")
      await vi.resetModules()
    }
  })

  it("reuses default chat state across webhook requests", async () => {
    await vi.resetModules()
    vi.doMock("../src/chat/runtime/agent-chat.ts", () => ({
      createChatBot: vi.fn(async (_agent, _options, _context, state) => ({
        webhooks: {
          slack: async () => {
            const lock = await state.acquireLock("thread-1", 60_000)
            return { locked: Boolean(lock) }
          },
        },
      })),
    }))

    try {
      const { defineAgent } = await import("../src/index.ts")
      const { chat } = await import("../src/capabilities.ts")
      const { defineAgentChatRegistryHandler } = await import("../src/nitro.ts")
      const agent = defineAgent({
        capabilities: [chat({ adapters: {} })],
        run: vi.fn(() => ({ text: "ok" })),
      })
      const handler = defineAgentChatRegistryHandler({
        support: async () => ({ default: agent as never }),
      })
      const createEvent = () => ({
        context: { params: { agent: "support", platform: "slack" } },
        req: new Request("https://example.com/agents/support/chat/slack", { method: "POST" }),
        url: "https://example.com/agents/support/chat/slack",
        waitUntil: vi.fn(),
      })

      await expect(handler(createEvent() as never)).resolves.toEqual({ locked: true })
      await expect(handler(createEvent() as never)).resolves.toEqual({ locked: false })
    }
    finally {
      vi.doUnmock("../src/chat/runtime/agent-chat.ts")
      await vi.resetModules()
    }
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
