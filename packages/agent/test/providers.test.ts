import { describe, expect, it, vi } from "vitest"

vi.mock("@vite-hub/internal/build/deployment-output", () => ({
  copyVercelFunctionRuntimePackages: vi.fn(async () => undefined),
}))

describe("agent Vite plugin", () => {
  it("ignores generated ViteHub files in the Vite dev watcher", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent()
    const config = plugin.config as (config: { server?: { watch?: { ignored?: string | string[] } } }) => { server?: { watch?: { ignored?: string[] } } }

    expect(config({}).server?.watch?.ignored).toEqual(["**/.vitehub/**"])
    expect(config({ server: { watch: { ignored: ["**/node_modules/**"] } } }).server?.watch?.ignored).toEqual([
      "**/node_modules/**",
      "**/.vitehub/**",
    ])
    expect(config({ server: { watch: { ignored: ["**/.vitehub/**"] } } }).server?.watch?.ignored).toEqual(["**/.vitehub/**"])
  })

  it("merges server noExternal", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent()

    const hook = plugin.configEnvironment
    const result = typeof hook === "function"
      ? hook.call({} as never, "ssr", {
          consumer: "server",
          resolve: { noExternal: ["existing"] },
        } as never, {} as never)
      : undefined

    expect(result).toMatchObject({
      resolve: { noExternal: ["existing", "@vite-hub/agent"] },
    })
  })

  it("exposes hubAgent options through Vite config", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ route: true })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined

    expect(result).toMatchObject({ agent: { route: true } })
  })

  it("registers configured agent routes with Nitro", async () => {
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ route: "/api/_vitehub/agents/[agent]/chat" })
    const result = typeof plugin.config === "function"
      ? await plugin.config.call({} as never, {}, { command: "build", mode: "production" })
      : undefined

    expect(result).toMatchObject({
      nitro: {
        handlers: [{
          handler: ".vitehub/agent/chat-route.ts",
          route: "/api/_vitehub/agents/:agent/chat",
        }],
      },
    })
  })

  it("materializes the MCP runtime package for Vercel build output", async () => {
    const { copyVercelFunctionRuntimePackages } = await import("@vite-hub/internal/build/deployment-output")
    const { hubAgent } = await import("../src/vite.ts")
    const plugin = hubAgent({ eval: false })
    const configResolved = plugin.configResolved as (config: { agent?: unknown, command: "build", root: string }) => Promise<void>
    const closeBundle = plugin.closeBundle as { handler: () => Promise<void> }
    vi.mocked(copyVercelFunctionRuntimePackages).mockClear()

    await configResolved({ command: "build", root: "/app" })
    await closeBundle.handler()

    expect(copyVercelFunctionRuntimePackages).toHaveBeenCalledWith({
      packages: [{ includePeerDependencies: true, name: "@ai-sdk/mcp", optional: true }],
      rootDir: "/app",
    })
  })
})

describe("server helpers", () => {
  it("rejects chat route requests without messages", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineAgentChatFetchHandler } = await import("../src/server.ts")
    const handler = defineAgentChatFetchHandler(defineAgent({ run: () => "unused" }) as never)

    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: JSON.stringify({}),
      method: "POST",
    }))

    await expect(response.json()).resolves.toMatchObject({
      message: "Agent chat route requires messages.",
      status: 400,
    })
    expect(response.status).toBe(400)
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

  it("returns declared HTTP errors", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineVercelAgentHandler } = await import("../src/vercel.ts")
    const error = new Error("Rejected")
    ;(error as { statusCode?: number }).statusCode = 403
    const handler = defineVercelAgentHandler(defineAgent({ run: () => { throw error } }) as never, { waitUntil: vi.fn() })

    const response = await handler(new Request("https://example.com/agents/triager", {
      body: JSON.stringify({ prompt: "blocked", stream: false }),
      method: "POST",
    }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: "Rejected" })
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

  it("returns declared HTTP errors", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineCloudflareAgentHandler } = await import("../src/cloudflare.ts")
    const error = new Error("Rejected")
    ;(error as { statusCode?: number }).statusCode = 403
    const handler = defineCloudflareAgentHandler(defineAgent({ run: () => { throw error } }) as never)

    const response = await handler(new Request("https://example.com/agents/triager", {
      body: JSON.stringify({ prompt: "blocked", stream: false }),
      method: "POST",
    }), {}, { waitUntil: vi.fn() })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: "Rejected" })
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
