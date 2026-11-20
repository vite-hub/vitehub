import { TeamsAdapter } from "@chat-adapter/teams"
import { jsonSchema, tool } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent, defineCapability } from "../src/index.ts"
import { teams } from "../src/channels.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"

// Signals each steering submission that reaches the active run's Driver, so the test can hold the
// run in a tool call until the follow-up arrives.
const steering = vi.hoisted(() => ({ submitted: [] as Array<() => void> }))
vi.mock("../src/internal/agent-invocation-control.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/internal/agent-invocation-control.ts")>()
  return {
    ...actual,
    registerAgentInvocationInputHandler: (id: string, handler: Parameters<typeof actual.registerAgentInvocationInputHandler>[1]) =>
      actual.registerAgentInvocationInputHandler(id, {
        sendInput(input, options) {
          const result = handler.sendInput(input, options)
          for (const signal of steering.submitted.splice(0)) signal()
          return result
        },
        get support() { return handler.support },
      }),
  }
})

const appId = "dev-app"
const serviceUrl = "https://smba.trafficmanager.net/emea/"
const usage = { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } }
afterEach(() => {
  vi.restoreAllMocks()
})

/** The real Teams adapter with Bot Framework auth and outbound REST calls stubbed. */
class TeamsFixture extends TeamsAdapter {
  readonly posts: string[] = []

  constructor() {
    super({ appId, appPassword: "test", userName: "Quiver Bot Dev" })
  }

  override async handleWebhook(request: Request, options?: { waitUntil?: (task: Promise<unknown>) => void }) {
    // SAFETY: Test-only access to the adapter's Teams SDK app, to skip JWT validation.
    const self = this as unknown as { app: { process: (event: unknown) => Promise<unknown> }, bridgeAdapter: { getWebhookOptions: () => unknown } }
    self.bridgeAdapter.getWebhookOptions = () => options
    await self.app.process({ body: await request.json(), token: { appId, serviceUrl, from: "azure", fromId: appId, isExpired: () => false, toString: () => "test-token" } })
    return Response.json({ ok: true })
  }

  // Attachment downloads return a small PNG instead of calling the network.
  override createFetchDataFn() { return async () => Buffer.from([137, 80, 78, 71]) }
  override async getUser() { return null }
  override async startTyping() {}
  override async deleteMessage() {}
  override async editMessage(threadId: string, id: string) { return { id, raw: {}, threadId } }
  override async postMessage(threadId: string, message: unknown) {
    // SAFETY: The route posts a string or a postable message with markdown.
    this.posts.push(typeof message === "string" ? message : String((message as { markdown?: string }).markdown ?? ""))
    return { id: `sent-${this.posts.length}`, raw: {}, threadId }
  }
}

function userTexts(prompt: Array<{ content: unknown, role: string }>): string[] {
  return prompt
    .filter(message => message.role === "user")
    .flatMap(message => typeof message.content === "string" ? [{ text: message.content, type: "text" }] : Array.isArray(message.content) ? message.content : [])
    .filter((part): part is { text: string, type: "text" } => part?.type === "text")
    .map(part => part.text)
}

/**
 * Bot Dev's Teams setup: a model-backed Agent that steers group chat mentions from any participant.
 * The first model step calls `lookup`, which waits until the follow-up reaches the Driver.
 */
function teamsAgent() {
  const adapter = new TeamsFixture()
  let generates = 0
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      generates += 1
      return generates === 1
        ? { content: [{ input: "{}", toolCallId: "lookup-1", toolName: "lookup", type: "tool-call" as const }], finishReason: { raw: "tool_calls", unified: "tool-calls" as const }, usage, warnings: [] }
        : { content: [{ text: "Opened the PR.", type: "text" as const }], finishReason: { raw: "stop", unified: "stop" as const }, usage, warnings: [] }
    },
  })
  let toolStarted!: () => void
  const toolRunning = new Promise<void>((resolve) => { toolStarted = resolve })
  const followUpSubmitted = new Promise<void>((resolve) => { steering.submitted.push(resolve) })
  const lookup = defineCapability({
    id: "lookup",
    tools: () => ({
      lookup: tool({
        description: "Looks up the branch.",
        execute: async () => {
          toolStarted()
          await followUpSubmitted
          return "branch found"
        },
        inputSchema: jsonSchema<Record<string, never>>({ properties: {}, type: "object" }),
      }),
    }),
  })
  const handler = createChannelWebhookRouteHandler(defineAgent({
    capabilities: [lookup],
    channels: {
      teams: teams({
        // SAFETY: The fixture is the real TeamsAdapter with network calls stubbed.
        adapter: () => adapter as never,
        messages: { concurrency: "steer", durable: false, loading: { text: "Thinking…" }, lockScope: "thread", steerFromParticipants: true, stream: false },
      }),
    },
    driver: { model },
    messages: { triggerHistory: "none" },
    name: "bot-dev",
    runtime: false,
  }))
  const tasks: Array<Promise<unknown>> = []
  const receive = (id: string, text: string, from: { id: string, name: string }, attachments?: unknown[]) => handler(new Request("https://agent-dev.example/api/webhooks/teams", {
    body: JSON.stringify({
      ...(attachments ? { attachments } : {}),
      channelData: { tenant: { id: "tenant" } },
      channelId: "msteams",
      conversation: { conversationType: "groupChat", id: "19:steer@thread.v2", isGroup: true, tenantId: "tenant" },
      entities: [{ mentioned: { id: `28:${appId}`, name: "Quiver Bot Dev" }, text: "<at>Quiver Bot Dev</at>", type: "mention" }],
      from,
      id,
      recipient: { id: `28:${appId}`, name: "Quiver Bot Dev" },
      serviceUrl,
      text: `<at>Quiver Bot Dev</at> ${text}`,
      timestamp: new Date().toISOString(),
      type: "message",
    }),
    method: "POST",
  }), "teams", { agentName: "bot-dev", waitUntil: task => tasks.push(Promise.resolve(task)) })
  const settle = async (...requests: Array<Promise<unknown>>) => {
    await Promise.allSettled(requests)
    // waitUntil tasks can schedule more tasks while they settle.
    while (tasks.length) await Promise.allSettled(tasks.splice(0))
  }
  return { model, receive, settle, toolRunning }
}

/** Delivery log lines with the given event type. */
function deliveryEvents(info: { mock: { calls: unknown[][] } }, type: string): Array<Record<string, unknown>> {
  return info.mock.calls.flatMap(([line]) => {
    if (typeof line !== "string" || !line.includes("vitehub.channel.delivery")) return []
    const event = JSON.parse(line) as Record<string, unknown>
    return event.type === type ? [event] : []
  })
}

describe("Teams steering into a model-backed run", () => {
  it("steers a group chat mention from another participant into the running invocation", { timeout: 15_000 }, async () => {
    const info = vi.spyOn(console, "info")
    const agent = teamsAgent()

    // The Teams adapter can hold the webhook response until the turn ends, so neither request is awaited here.
    const first = agent.receive("1001", "open pr with a beaf", { id: "29:maxi", name: "Maxi" })
    await agent.toolRunning
    const second = agent.receive("1002", "steer with the gergo message", { id: "29:gergo", name: "Gergo" })
    await agent.settle(first, second)

    // One invocation: step 1 (tool call) and step 2 (answer). A follow-up that waited for the run
    // to end instead starts a second invocation, with another model call.
    expect(agent.model.doGenerateCalls).toHaveLength(2)
    const followUp = userTexts(agent.model.doGenerateCalls[1]!.prompt).join("\n")
    expect(followUp).toContain("steer with the gergo message")
    expect(followUp).toMatch(/msg 1002 · from Gergo \(id 29:gergo\)/)
    expect(deliveryEvents(info, "steer.deferred")).toEqual([])
  })

  it("runs an image follow-up after the active run and records why it could not steer", { timeout: 15_000 }, async () => {
    const info = vi.spyOn(console, "info")
    const agent = teamsAgent()

    const first = agent.receive("2001", "open pr with a beaf", { id: "29:maxi", name: "Maxi" })
    await agent.toolRunning
    const second = agent.receive("2002", "use this screenshot", { id: "29:gergo", name: "Gergo" }, [
      { contentType: "image/png", contentUrl: "https://example.com/screenshot.png", name: "screenshot.png" },
    ])
    await agent.settle(first, second)

    // The follow-up starts its own invocation after the first one: three model calls in all.
    expect(agent.model.doGenerateCalls).toHaveLength(3)
    expect(userTexts(agent.model.doGenerateCalls[1]!.prompt).join("\n")).not.toContain("use this screenshot")
    expect(userTexts(agent.model.doGenerateCalls[2]!.prompt).join("\n")).toContain("use this screenshot")
    const deferred = deliveryEvents(info, "steer.deferred")
    expect(deferred).toEqual([expect.objectContaining({ reason: "attachments", runId: expect.any(String) })])
  })
})
