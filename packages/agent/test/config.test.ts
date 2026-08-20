import { describe, expect, it, vi } from "vitest"

import { normalizeAgentOptions } from "../src/config.ts"

describe("agent config", () => {
  it("defaults Agent Definitions to workflows with an inline opt-out", async () => {
    const { defineAgent } = await import("../src/index.ts")

    expect(defineAgent({ driver: { run: () => "queued" } }).runtime).toEqual({ discoveryDefault: true, kind: "workflow" })
    expect(defineAgent({ driver: { run: () => "inline" }, runtime: false }).runtime).toBe(false)
  })

  it("normalizes defaults", () => {
    expect(normalizeAgentOptions(undefined)).toEqual({
      execution: "inline",
      imports: true,
      integrations: {
        sandbox: "auto",
        workflow: "auto",
      },
      providers: {
        sandbox: { provider: "auto" },
        scheduler: { provider: "auto" },
        state: { provider: "auto" },
      },
      routes: {
        discordGateway: false,
        inspection: false,
        webhooks: "/api/_vitehub/agents/[agent]/webhooks/[webhook]",
      },
      runtime: "auto",
    })
  })

  it("preserves provider options", () => {
    expect(normalizeAgentOptions({
      integrations: { sandbox: false },
      providers: { state: { provider: "sqlite", tablePrefix: "agent_state_", url: "file:agent-state.sqlite" } },
      runtime: "cloudflare-agents",
    })).toMatchObject({
      integrations: { sandbox: false, workflow: "auto" },
      providers: { state: { provider: "sqlite", tablePrefix: "agent_state_", url: "file:agent-state.sqlite" } },
      routes: {
        discordGateway: false,
        inspection: false,
        webhooks: "/api/_vitehub/agents/[agent]/webhooks/[webhook]",
      },
      runtime: "cloudflare-agents",
    })
  })

  it("normalizes the optional Discord Gateway route with the required webhook route", () => {
    expect(normalizeAgentOptions({ routes: { discordGateway: true } })).toMatchObject({
      routes: {
        discordGateway: "/api/_vitehub/agents/[agent]/discord/gateway",
        webhooks: "/api/_vitehub/agents/[agent]/webhooks/[webhook]",
      },
    })
    expect(normalizeAgentOptions({ routes: { discordGateway: "/discord/gateway" } })).toMatchObject({
      routes: {
        discordGateway: "/discord/gateway",
        webhooks: "/api/_vitehub/agents/[agent]/webhooks/[webhook]",
      },
    })
    expect(normalizeAgentOptions({ routes: { discordGateway: false } })).toMatchObject({
      routes: {
        discordGateway: false,
        webhooks: "/api/_vitehub/agents/[agent]/webhooks/[webhook]",
      },
    })
  })

  it("normalizes the optional inspection route", () => {
    expect(normalizeAgentOptions({ routes: { inspection: true } })).toMatchObject({
      routes: { inspection: "/api/_vitehub/agents/[agent]/inspection" },
    })
    expect(normalizeAgentOptions({ routes: { inspection: "/internal/agents/[agent]" } })).toMatchObject({
      routes: { inspection: "/internal/agents/[agent]" },
    })
    expect(normalizeAgentOptions({ routes: { inspection: false } })).toMatchObject({ routes: { inspection: false } })
  })

  it("preserves Deno runtime selection", () => {
    expect(normalizeAgentOptions({ runtime: "deno" })).toMatchObject({
      runtime: "deno",
    })
  })

  it("keeps AI SDK loading out of the root Agent import", async () => {
    vi.resetModules()
    let loadedAi = false
    vi.doMock("ai", async (importOriginal) => {
      loadedAi = true
      return await importOriginal<typeof import("ai")>()
    })
    try {
      const agent = await import("../src/index.ts")
      expect(agent.defineAgent).toBeTypeOf("function")
      expect(loadedAi).toBe(false)
    }
    finally {
      vi.doUnmock("ai")
      vi.resetModules()
    }
  })

  it("keeps workspace loading out of the root Agent import", async () => {
    vi.resetModules()
    vi.doMock("@vite-hub/workspace", () => {
      throw new Error("workspace should only load when a workspace-backed path is used")
    })
    try {
      const agent = await import("../src/index.ts")
      expect(agent.defineAgent).toBeTypeOf("function")
      expect(agent.defineAgent({
        driver: { run: async () => "ok", },
      }).run).toBeTypeOf("function")
      expect(agent).not.toHaveProperty("withAgentDefaults")
    }
    finally {
      vi.doUnmock("@vite-hub/workspace")
      vi.resetModules()
    }
  })

  it("keeps workspace runtime loading out of the internal Agent server route import", async () => {
    vi.resetModules()
    vi.doMock("@vite-hub/workspace", () => {
      throw new Error("workspace should only load when a workspace-backed path is used")
    })
    vi.doMock("@vite-hub/workspace/runtime", () => {
      throw new Error("workspace runtime should only load when workspace registration is used")
    })
    try {
      const publicServer = await import("../src/server.ts")
      expect(publicServer).not.toHaveProperty("createChannelChatRouteHandler")
      expect(publicServer).not.toHaveProperty("createChannelWebhookRouteHandler")
      const server = await import("../src/server/internal.ts")
      expect(server.createChannelChatRouteHandler).toBeTypeOf("function")
      expect(server.createChannelWebhookRouteHandler).toBeTypeOf("function")
    }
    finally {
      vi.doUnmock("@vite-hub/workspace")
      vi.doUnmock("@vite-hub/workspace/runtime")
      vi.resetModules()
    }
  })

  it("does not read Vercel env while handling Deno chat routes", async () => {
    vi.resetModules()
    let loadedVercelFunctions = false
    let loadedAi = false
    vi.doMock("@vercel/functions", async (importOriginal) => {
      loadedVercelFunctions = true
      return await importOriginal<typeof import("@vercel/functions")>()
    })
    vi.doMock("ai", async (importOriginal) => {
      loadedAi = true
      return await importOriginal<typeof import("ai")>()
    })
    const originalDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno")
    const originalEnv = Object.getOwnPropertyDescriptor(process, "env")
    Object.defineProperty(globalThis, "Deno", { configurable: true, value: {} })
    Object.defineProperty(process, "env", {
      configurable: true,
      value: new Proxy(process.env, {
        get(target, property, receiver) {
          if (property === "VERCEL") {
            throw new Error("VERCEL env should not be read for Deno routes")
          }
          return Reflect.get(target, property, receiver)
        },
      }),
    })
    try {
      const { defineAgent } = await import("../src/index.ts")
      const { chat } = await import("../src/capabilities.ts")
      const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
      const handler = createChannelChatRouteHandler(defineAgent({
        capabilities: [chat()],
        driver: { run({ messages }) {
            const text = messages[0]?.parts.find((part: { type?: string }) => part.type === "text") as { text?: string } | undefined
            return `deno ${text?.text}`
          } },
      }) as never)

      const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
        body: JSON.stringify({
          id: "thread",
          messages: [{
            id: "user-1",
            parts: [{ text: "ping", type: "text" }],
            role: "user",
          }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }), { agentName: "support" })

      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toContain("deno ping")
      expect(loadedAi).toBe(false)
      expect(loadedVercelFunctions).toBe(false)
    }
    finally {
      if (originalDeno) Object.defineProperty(globalThis, "Deno", originalDeno)
      else Reflect.deleteProperty(globalThis, "Deno")
      if (originalEnv) Object.defineProperty(process, "env", originalEnv)
      vi.doUnmock("ai")
      vi.doUnmock("@vercel/functions")
      vi.resetModules()
    }
  })

  it("keeps workspace loading out of the capabilities barrel for chat", async () => {
    vi.resetModules()
    vi.doMock("@vite-hub/workspace", () => {
      throw new Error("workspace should only load when a workspace-backed path is used")
    })
    try {
      const capabilities = await import("../src/capabilities.ts")
      expect(capabilities.chat).toBeTypeOf("function")
      expect(capabilities.chat()).toMatchObject({ id: "chat" })
    }
    finally {
      vi.doUnmock("@vite-hub/workspace")
      vi.resetModules()
    }
  })

  it("infers workspaces from custom contributions regardless of public metadata", async () => {
    const { defineAgent, defineCapability } = await import("../src/index.ts")

    expect(defineAgent({
      capabilities: [
        defineCapability({
          id: "custom",
          metadata: { workspaceOptional: true },
          workspace: {
            sources: {
              notes: {
                async getKeys() {
                  return []
                },
                async getItem(key: string) {
                  return { content: "", key }
                },
              },
            },
          },
        }),
      ],
      driver: { run: () => "ok" },
    })).toMatchObject({
      __vitehubWorkspaceAgent: true,
      __vitehubWorkspaceAgentOptions: { workspace: {} },
    })
  })

})
