import { describe, expect, it, vi } from "vitest"

const loaded = vi.hoisted(() => new Set<string>())

vi.mock("chat", async (importOriginal) => {
  loaded.add("chat")
  return await importOriginal()
})

const { defineAgent } = await import("../src/index.ts")
const { webChat } = await import("../src/channels.ts")
// Generated host code imports the handlers from this entry when the server starts.
const handlers = await import("../src/server/internal.ts")

describe("Agent route handlers", () => {
  it("creates handlers and resolves declared webhook paths without loading the routes", async () => {
    const agent = defineAgent({ channels: { web: webChat() }, driver: { run: () => "ok" } })
    const routeLoads = vi.fn()
    handlers.onAgentRoutesLoad(routeLoads)

    handlers.createChannelChatRouteHandler(agent as never)
    const webhook = handlers.createChannelWebhookRouteHandler(agent as never)
    handlers.createDiscordGatewayRouteHandler(agent as never)
    const matches = await webhook.declaredPathMatcher(new Request("https://app.example/hello"), { agentName: "support" })

    expect(matches("/hello")).toBe(false)
    await expect(handlers.drainInlineChatInvocations()).resolves.toEqual({ active: 0, interrupted: 0, unsettled: 0 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(routeLoads).not.toHaveBeenCalled()
    expect([...loaded]).toEqual([])

    await webhook.channels(new Request("https://app.example/_vitehub/channels"), { agentName: "support" })
    expect(loaded.has("chat")).toBe(true)
    expect(routeLoads).toHaveBeenCalledOnce()
  })
})
