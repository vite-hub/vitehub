import type { Plugin } from "vite"

import { renderChannelSimulatorPage } from "../../packages/agent/src/internal/channel-simulator/page.ts"
import type { ConsoleRpcResult } from "../../packages/vite-hub/src/console/runtime/rpc.ts"

/**
 * The Channels section without Agents. `release-engineer` has two simulated Channels, as `agent.channels.simulate`
 * gives them in `vite dev`, and `product-reviewer` has a real Telegram Channel with a durable State. The simulated
 * Channels serve the real chat page of `@vite-hub/agent`, but no Agent answers its messages here.
 */

// A simulated Channel has no provider history, so channels.list gives it no warning.
const simulated = { durable: false, maxMessages: 100, mode: "provider-window", transcripts: false, ttlMs: 604_800_000 }
const providerWindow = {
  ...simulated,
  warning: "Transcripts are not durable. The provider keeps 100 messages for 7 days, so older messages may be missing.",
}
const durable = { durable: true, maxMessages: 100, mode: "durable-transcripts", transcripts: true, ttlMs: 604_800_000 }

const simulatorRoute = (agent: string, channel: string) => `/api/_vitehub/agents/${agent}/webhooks/${channel}`

const channels = [
  { agent: "release-engineer", channel: "slack", conversations: true, provider: "slack", retention: simulated, simulated: true, simulator: simulatorRoute("release-engineer", "slack") },
  { agent: "release-engineer", channel: "discord", conversations: true, provider: "discord", retention: simulated, simulated: true, simulator: simulatorRoute("release-engineer", "discord") },
  { agent: "product-reviewer", channel: "telegram", conversations: true, provider: "telegram", retention: durable, simulated: false },
]

const threads: Record<string, Array<{ invocationCount: number, lastMessageAt: string, participants: string[], thread: string, title?: string }>> = {
  "product-reviewer/telegram": [
    { invocationCount: 2, lastMessageAt: "2026-10-28T14:40:00.000Z", participants: ["Lucía Romero"], thread: "telegram:4217", title: "Review the checkout copy" },
  ],
  "release-engineer/slack": [
    { invocationCount: 1, lastMessageAt: "2026-10-28T15:02:00.000Z", participants: ["learner"], thread: "slack:learner:try-1" },
  ],
}

const conversations: Record<string, Array<{ at: string, author: { isBot?: boolean, name: string }, id: string, role: "assistant" | "user", text: string }>> = {
  "slack:learner:try-1": [
    { at: "2026-10-28T15:01:00.000Z", author: { name: "learner" }, id: "m1", role: "user", text: "Is the 0.0.5 release ready?" },
    { at: "2026-10-28T15:02:00.000Z", author: { isBot: true, name: "release-engineer" }, id: "m2", role: "assistant", text: "Two checks are still running. I will post here when they pass." },
  ],
  "telegram:4217": [
    { at: "2026-10-28T14:38:00.000Z", author: { name: "Lucía Romero" }, id: "t1", role: "user", text: "Can you review the checkout copy?" },
    { at: "2026-10-28T14:40:00.000Z", author: { isBot: true, name: "product-reviewer" }, id: "t2", role: "assistant", text: "The button says **Pay** but the summary says *Order*. Use one word." },
  ],
}

function retentionOf(agent: unknown, channel: unknown) {
  return channels.find(entry => entry.agent === agent && entry.channel === channel)?.retention ?? providerWindow
}

/** Answers the `channels.*` operations, or `undefined` for other operations. */
export function channelsFixture(operation: string, input: Record<string, unknown>): ConsoleRpcResult | undefined {
  if (operation === "channels.list") return { ok: true, value: { channels } }
  if (operation === "channels.threads") {
    return { ok: true, value: { agent: input.agent, channel: input.channel, threads: threads[`${input.agent}/${input.channel}`] ?? [] } }
  }
  if (operation === "channels.conversation") {
    const messages = (conversations[String(input.thread)] ?? []).map(message => ({ ...message, attachments: [], source: "provider" }))
    return { ok: true, value: { agent: input.agent, channel: input.channel, messageCount: messages.length, messages, retention: retentionOf(input.agent, input.channel), thread: input.thread } }
  }
  return undefined
}

/** Serves the chat page of each simulated Channel on its webhook route, as the Agent route does on a browser GET. */
export function channelSimulatorPages(): Plugin {
  return {
    name: "vitehub-console-playground-channel-simulator",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0]
        const entry = channels.find(candidate => candidate.simulator === path)
        if (request.method !== "GET" || !entry?.simulator) {
          next()
          return
        }
        const links = channels.flatMap(candidate => candidate.agent === entry.agent && candidate.simulator ? [{ id: candidate.channel, kind: candidate.provider, route: candidate.simulator }] : [])
        response.setHeader("cache-control", "no-store")
        response.setHeader("content-type", "text/html; charset=utf-8")
        response.end(renderChannelSimulatorPage(entry.provider, { agent: entry.agent, channel: entry.channel, channels: links, route: entry.simulator }))
      })
    },
  }
}
