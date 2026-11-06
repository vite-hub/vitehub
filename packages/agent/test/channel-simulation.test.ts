import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Script } from "node:vm"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { installChannelsConsoleHost } from "../src/channels-console-host.ts"
import { discord, slack, teams, telegram } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { channelSimulationEnv, isChannelSimulated } from "../src/internal/channel-simulation.ts"
import { inspectMessageChannelInstructions } from "../src/internal/channels.ts"
import { agentChannelOperations } from "../src/operations.ts"
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

const [channelsList, channelsThreads, channelsConversation, conversationsExport] = agentChannelOperations
const consoleContext = { access: { mode: "open", sections: "all" }, request: new Request("http://vitehub.local/_vitehub/rpc/__call"), surface: "console", user: null } as const

/** Runs `channels.list` for one Agent named `support`, the way the Console and `vitehub channels list` call it. */
async function listChannels(channels: Parameters<typeof defineAgent>[0]["channels"]) {
  const agent = defineAgent({ channels, driver: { run: () => "ok" } })
  installChannelsConsoleHost({
    agents: { support: agent },
    handlers: { support: createChannelWebhookRouteHandler(agent) },
    options: () => ({ agentIdentity: { name: "support" } }),
  })
  return await channelsList.run({}, consoleContext)
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
      expect(html.match(/<span class="sim-label">/g), channel).toHaveLength(1)
      expect(html, channel).toContain(`<div class="sim-strip"><span class="sim-label">Unofficial <span class="sim-optional">simulator </span>· not affiliated with ${platform}</span>`)
      // The embed check runs in <head>, before the first paint, so an embedded page never shows its app chrome.
      const head = html.slice(0, html.indexOf("</head>"))
      expect(head, channel).toContain("<script>if(self!==top)document.documentElement.dataset.embed=\"\"</script>")
      expect(html, channel).toContain("[data-embed]")
      expect(html, channel).toContain(`"route":"${route}"`)
      expect(html, channel).not.toMatch(/<link|<img|\bsrc=|@import|url\(\s*["']?https?:/)
      const script = /<script type="module">([\s\S]*)<\/script>/.exec(html)?.[1] ?? ""
      expect(() => new Script(script), channel).not.toThrow()
    }
  })

  it("links the other simulated Channels of the Agent from each chat page", async () => {
    const agent = defineAgent({
      channels: { discord: discord(), helpdesk: slack(), telegram: telegram() },
      driver: { run: () => "ok" },
    })
    const handler = createChannelWebhookRouteHandler(agent)
    const html = await (await handler(new Request("https://example.com/hooks/support/helpdesk/in"), "helpdesk", { agentName: "support" })).text()
    // The switcher is in the strip with the unofficial label. A narrow screen shows the select instead of the links.
    const strip = /<div class="sim-strip">(.*?)<\/div>/.exec(html)?.[1]
    const links = /<nav class="sim-switch" aria-label="Simulated Channels"><span class="sim-links">(.*?)<\/span>/.exec(strip ?? "")?.[1]
    expect(links).toBe([
      "<a href=\"/hooks/support/discord/in\">Discord</a>",
      "<a aria-current=\"page\">Slack (helpdesk)</a>",
      "<a href=\"/hooks/support/telegram/in\">Telegram</a>",
    ].join(""))
    expect(/<select aria-label="Simulated Channel"[^>]*>(.*?)<\/select>/.exec(strip ?? "")?.[1]).toBe([
      "<option value=\"/hooks/support/discord/in\">Discord</option>",
      "<option value=\"/hooks/support/helpdesk/in\" selected>Slack (helpdesk)</option>",
      "<option value=\"/hooks/support/telegram/in\">Telegram</option>",
    ].join(""))
    expect(html).toContain("[data-embed] .sim-switch { display: none; }")

    const single = defineAgent({ channels: { slack: slack() }, driver: { run: () => "ok" } })
    const alone = await (await createChannelWebhookRouteHandler(single)(new Request("https://example.com/api/_vitehub/agents/support/webhooks/slack"), "slack", { agentName: "support" })).text()
    expect(alone).not.toContain("<nav class=\"sim-switch\"")
  })

  it("marks simulated Channels in the Channel list, with the path of their chat page", async () => {
    const result = await listChannels({ discord: discord(), slack: slack() })
    expect(result.channels).toEqual([
      expect.objectContaining({ agent: "support", channel: "discord", provider: "discord", simulated: true, simulator: "/api/_vitehub/agents/support/webhooks/discord" }),
      expect.objectContaining({ agent: "support", channel: "slack", provider: "slack", simulated: true, simulator: "/api/_vitehub/agents/support/webhooks/slack" }),
    ])
    // The chat page keeps the messages in browser memory, so the provider window is not a reason to warn.
    for (const channel of result.channels) expect(channel.retention, channel.channel).not.toHaveProperty("warning")
    expect(channelsList.cli?.format?.(result)).toBe([
      "AGENT    CHANNEL  PROVIDER             HISTORY          CHAT PAGE",
      "support  discord  discord (simulated)  provider-window  /api/_vitehub/agents/support/webhooks/discord",
      "support  slack    slack (simulated)    provider-window  /api/_vitehub/agents/support/webhooks/slack",
      "",
    ].join("\n"))
  })

  it("lists Channels as not simulated when simulation is off", async () => {
    delete process.env[channelSimulationEnv]
    const result = await listChannels({ telegram: telegram() })
    expect(result.channels).toEqual([expect.objectContaining({ channel: "telegram", provider: "telegram", simulated: false })])
    expect(result.channels[0]).not.toHaveProperty("simulator")
    expect(result.channels[0]?.retention.warning).toContain("older messages may be missing")
  })

  it("reads the threads and conversations of a simulated Channel without the provider window warning", async () => {
    // The default state keeps no durable transcripts, so a real Channel would warn about the provider window.
    const agent = defineAgent({ channels: { slack: slack() }, driver: { run: context => `echo: ${lastUserText(context)}` } })
    const handler = createChannelWebhookRouteHandler(agent)
    await (await handler(chatRequest("slack", "hi"), "slack", { agentName: "support" })).text()
    installChannelsConsoleHost({ agents: { support: agent }, handlers: { support: handler }, options: () => ({ agentIdentity: { name: "support" } }) })
    const { retention } = await channelsThreads.run({ agent: "support", channel: "slack" }, consoleContext)
    expect(retention).toMatchObject({ durable: false, mode: "provider-window" })
    expect(retention).not.toHaveProperty("warning")

    const retentionWindow = { durable: false, maxMessages: 100, transcripts: false, ttlMs: 604_800_000 }
    const conversation = { agent: "support", channel: "slack", messages: [], participants: [], provider: "slack", retention: retentionWindow, threadId: "slack:learner:c", truncated: false }
    for (const simulated of [true, false]) {
      // SAFETY: The test host has the members of the webhook handler that the conversation operations call.
      const reader = { conversation: async () => ({ ...conversation, simulated }) } as unknown as typeof handler
      installChannelsConsoleHost({ agents: { support: agent }, handlers: { support: reader }, options: () => ({}) })
      const input = { agent: "support", channel: "slack", thread: "slack:learner:c" }
      const read = await channelsConversation.run(input, consoleContext)
      const exported = await conversationsExport.run({ ...input, format: "markdown", media: false }, consoleContext)
      expect(read.retention.warning === undefined, `simulated: ${simulated}`).toBe(simulated)
      expect(exported.retention.warning === undefined, `simulated: ${simulated}`).toBe(simulated)
      expect(exported.text.includes("Warning: transcripts are not durable"), `simulated: ${simulated}`).toBe(!simulated)
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
