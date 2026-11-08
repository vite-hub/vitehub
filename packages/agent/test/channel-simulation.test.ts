import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { getCloudflareWorkflowBindingName } from "@vite-hub/workflow"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig } from "@vite-hub/workflow/runtime/state"
import { defineChannel, discord, slack, teams, telegram } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { channelSimulationEnv, createSimulatedChatAdapter, isChannelSimulated } from "../src/internal/channel-simulation.ts"
import { inspectMessageChannelInstructions } from "../src/internal/channels.ts"
import { createChannelWebhookRouteHandler, createDiscordGatewayRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

import type { AgentRunContext } from "../src/index.ts"
import type { ChatInstance } from "chat"

function chatRequest(channel: string, text: string): Request {
  return new Request(`https://example.com/api/_vitehub/agents/support/webhooks/${channel}`, {
    body: JSON.stringify({ id: `conversation-${channel}`, messages: [{ id: `message-${channel}`, role: "user", parts: [{ type: "text", text }] }] }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

function streamedText(body: string): string {
  return body.split("\n\n")
    .map(event => event.replace(/^data: /, ""))
    .filter(data => data.startsWith("{"))
    .map(data => JSON.parse(data) as { type: string, delta?: string })
    .filter(part => part.type === "text-delta")
    .map(part => part.delta)
    .join("")
}

function lastUserText({ messages }: AgentRunContext): string {
  const parts = messages.filter(message => message.role === "user").at(-1)?.parts ?? []
  return parts.map(part => part.type === "text" ? part.text : "").join("")
}

describe("simulated chat Channels", () => {
  const previous = { simulate: process.env[channelSimulationEnv], nodeEnv: process.env.NODE_ENV }

  beforeEach(() => {
    process.env[channelSimulationEnv] = "simulate"
    process.env.NODE_ENV = "development"
  })

  afterEach(() => {
    for (const [key, value] of [[channelSimulationEnv, previous.simulate], ["NODE_ENV", previous.nodeEnv]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it("simulates only the built-in chat Channels, and never in production", () => {
    expect(isChannelSimulated("discord")).toBe(true)
    expect(isChannelSimulated("github")).toBe(false)
    process.env.NODE_ENV = "production"
    expect(isChannelSimulated("discord")).toBe(false)
    delete process.env[channelSimulationEnv]
    process.env.NODE_ENV = "development"
    expect(isChannelSimulated("discord")).toBe(false)
  })

  it("streams the reply of each Channel as an AI SDK chat, without credentials", { timeout: 20_000 }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-channel-simulation-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const agent = defineAgent({
      channels: { discord: discord(), slack: slack(), teams: teams(), telegram: telegram() },
      driver: { run: context => `echo: ${lastUserText(context)}` },
    })
    const handler = createChannelWebhookRouteHandler(agent)
    try {
      for (const channel of ["discord", "slack", "teams", "telegram"]) {
        const response = await handler(chatRequest(channel, `hi ${channel}`), channel, { agentName: "support", state })
        expect(response.status, channel).toBe(200)
        expect(response.headers.get("content-type"), channel).toContain("text/event-stream")
        expect(streamedText(await response.text()), channel).toBe(`echo: hi ${channel}`)
      }
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it("keeps the Channel instructions and turns off provider listeners and webhook verification", () => {
    const polling = telegram({ mode: "polling" })
    expect(inspectMessageChannelInstructions({ telegram: polling }).join("\n")).toContain("Telegram")
    expect(polling.listener).toBeUndefined()
    expect(polling.webhooks).toBe(true)
    expect(telegram().webhooks).toMatchObject({ secretToken: false })
  })

  it.each([undefined, true])("keeps buffered replies in the request with an active Workflow (durable: %s)", async (durable) => {
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-channel-simulation-workflow-"))
    const state = Object.assign(createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` }), { workflowCustody: true })
    const createBatch = vi.fn(async ([{ id }]: Array<{ id: string }>) => [{ id, status: async () => ({ status: "queued" }) }])
    const run = vi.fn(() => "inline simulated reply")
    const agent = defineAgent({
      channels: { telegram: telegram({ messages: { durable, final: { delivery: "new-message" }, loading: { text: "Thinking" }, state } }) },
      driver: { run },
    })
    setWorkflowRuntimeConfig({ provider: "cloudflare" })
    try {
      const response = await createChannelWebhookRouteHandler(agent)(chatRequest("telegram", "hi"), "telegram", {
        agentIdentity: { name: "support" },
        cloudflare: { env: { [getCloudflareWorkflowBindingName("support")]: { createBatch, get: vi.fn() } } },
      })
      expect(response.status).toBe(200)
      expect(streamedText(await response.text())).toBe("Thinkinginline simulated reply")
      expect(run).toHaveBeenCalledOnce()
      expect(createBatch).not.toHaveBeenCalled()
    }
    finally {
      resetWorkflowRuntime()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it.each([false, true])("skips custom webhook verification (registration array: %s)", async (array) => {
    const verify = vi.fn(() => false)
    const registration = { signature: { verify }, secretToken: "provider-secret", secretHeader: "x-provider-signature" }
    const channel = defineChannel("discord", { webhooks: array ? [registration] : registration })
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-channel-simulation-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    try {
      const agent = defineAgent({ channels: { discord: channel }, driver: { run: () => "verified simulation" } })
      const response = await createChannelWebhookRouteHandler(agent)(chatRequest("discord", "hi"), "discord", { agentName: "support", state })
      expect(response.status).toBe(200)
      expect(streamedText(await response.text())).toBe("verified simulation")
      expect(verify).not.toHaveBeenCalled()
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it.each([false, true])("isolates overlapping requests for one conversation (second completes first: %s)", async (reverse) => {
    const adapter = await createSimulatedChatAdapter("discord")
    const pending: Array<{ reply: () => Promise<void>, complete: () => void }> = []
    const chat: Pick<ChatInstance, "processMessage"> = {
      processMessage(requestAdapter, threadId) {
        let complete!: () => void
        const done = new Promise<void>((resolve) => { complete = resolve })
        const index = pending.length
        pending.push({
          complete,
          reply: async () => {
            await requestAdapter.postMessage(threadId, { markdown: `post ${index}` })
            await requestAdapter.stream?.(threadId, (async function* () { yield `stream ${index}` })())
          },
        })
        return done
      },
    }
    // SAFETY: The web adapter uses only processMessage on the initialized Chat instance.
    await adapter.initialize(chat as ChatInstance)
    const first = await adapter.handleWebhook(chatRequest("discord", "first"))
    const second = await adapter.handleWebhook(chatRequest("discord", "second"))
    // Reply outside the inbound async context, as in a WebContainer after an await.
    // Completing either request must leave the other's captured context intact.
    for (const index of reverse ? [1, 0] : [0, 1]) {
      await pending[index]!.reply()
      pending[index]!.complete()
      expect(streamedText(await [first, second][index]!.text())).toBe(`post ${index}stream ${index}`)
    }
  })

  it("starts no Discord Gateway for a simulated Discord Channel", async () => {
    const agent = defineAgent({ channels: { discord: discord() }, driver: { run: () => "ok" } })
    const response = await createDiscordGatewayRouteHandler(agent)(new Request("https://example.com/api/_vitehub/agents/support/discord/gateway"), { durationMs: 1 })
    expect(response.status).toBe(204)
  })

  it("leaves Channels alone when simulation is off", () => {
    delete process.env[channelSimulationEnv]
    expect(telegram({ mode: "polling" }).listener).toEqual({ kind: "telegram-polling" })
  })
})
