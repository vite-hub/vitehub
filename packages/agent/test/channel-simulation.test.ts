import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Script } from "node:vm"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { discord, slack, teams, telegram } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { channelSimulationEnv, isChannelSimulated } from "../src/internal/channel-simulation.ts"
import { inspectMessageChannelInstructions } from "../src/internal/channels.ts"
import { createChannelWebhookRouteHandler, createDiscordGatewayRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

import type { AgentRunContext } from "../src/index.ts"

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

  it("opens a chat page in the look of the platform on a browser GET of the webhook route", async () => {
    const agent = defineAgent({
      channels: { discord: discord(), slack: slack(), teams: teams(), telegram: telegram() },
      driver: { run: () => "ok" },
    })
    const handler = createChannelWebhookRouteHandler(agent)
    const platforms = { discord: "Discord", slack: "Slack", teams: "Microsoft Teams", telegram: "Telegram" }
    for (const [channel, platform] of Object.entries(platforms)) {
      const route = `/api/_vitehub/agents/support/webhooks/${channel}`
      const response = await handler(new Request(`https://example.com${route}`), channel, { agentName: "support" })
      expect(response.status, channel).toBe(200)
      expect(response.headers.get("content-type"), channel).toBe("text/html; charset=utf-8")
      const html = await response.text()
      expect(html, channel).toContain(`Unofficial simulator · not affiliated with ${platform}`)
      expect(html, channel).toContain(`"route":"${route}"`)
      expect(html, channel).not.toMatch(/<link|<img|\bsrc=|@import|url\(\s*["']?https?:/)
      const script = /<script type="module">([\s\S]*)<\/script>/.exec(html)?.[1] ?? ""
      expect(() => new Script(script), channel).not.toThrow()
    }
  })

  it("escapes the Agent name in the chat page", async () => {
    const agent = defineAgent({ channels: { slack: slack() }, driver: { run: () => "ok" } })
    const response = await createChannelWebhookRouteHandler(agent)(new Request("https://example.com/api/_vitehub/agents/x/webhooks/slack"), "slack", { agentName: "</script><img>" })
    const html = await response.text()
    expect(html).not.toContain("</script><img>")
    expect(html).toContain("&lt;/script&gt;&lt;img&gt;")
  })

  it("keeps the Channel instructions and turns off provider listeners and webhook verification", () => {
    const polling = telegram({ mode: "polling" })
    expect(inspectMessageChannelInstructions({ telegram: polling }).join("\n")).toContain("Telegram")
    expect(polling.listener).toBeUndefined()
    expect(polling.webhooks).toBe(true)
    expect(telegram().webhooks).toMatchObject({ secretToken: false })
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

  it("answers a GET with 405 when simulation is off", async () => {
    delete process.env[channelSimulationEnv]
    const agent = defineAgent({ channels: { discord: discord() }, driver: { run: () => "ok" } })
    const response = await createChannelWebhookRouteHandler(agent)(new Request("https://example.com/api/_vitehub/agents/support/webhooks/discord"), "discord", { agentName: "support" })
    expect(response.status).toBe(405)
  })
})
