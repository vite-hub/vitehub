import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Message } from "chat"
import { expect, it, vi } from "vitest"

import { telegram } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { agentChannelDeliveryPayloadFingerprint, readAgentChannelDeliveries } from "../src/internal/channel-delivery.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

import type { Adapter, ChatInstance, WebhookOptions } from "chat"

function telegramBody(messageId: number, text: string) {
  return { message: { chat: { id: 456, type: "private" }, from: { id: 123, username: "maxi" }, message_id: messageId, text }, ts: "1.2", type: "event_callback" }
}

function chatAdapter(): Adapter {
  let chat: ChatInstance | undefined
  const adapter = {
    name: "custom-chat",
    userName: "vitehub",
    channelIdFromThreadId: (threadId: string) => threadId,
    initialize: async (instance: ChatInstance) => { chat = instance },
    isDM: () => true,
    startTyping: async () => {},
    deleteMessage: async () => {},
    editMessage: async (threadId: string, id: string) => ({ id, raw: {}, threadId }),
    fetchMessages: async () => ({ messages: [] }),
    postMessage: async (threadId: string) => ({ id: `sent-${threadId}`, raw: {}, threadId }),
    handleWebhook: async (request: Request, options?: WebhookOptions) => {
      const body = await request.json() as ReturnType<typeof telegramBody>
      const message = new Message({
        attachments: [],
        author: { fullName: "maxi", isBot: false, isMe: false, userId: "123", userName: "maxi" },
        formatted: { children: [], type: "root" },
        id: `chat-${body.message.message_id}`,
        metadata: { dateSent: new Date("2026-06-10T12:00:00.000Z"), edited: false },
        raw: body,
        text: body.message.text,
        threadId: "telegram:456",
      })
      await chat!.processMessage(adapter as unknown as Adapter, message.threadId, message, options)
      return Response.json({ ok: true })
    },
  }
  return adapter as unknown as Adapter
}

function webhook(messageId: number, text: string) {
  return new Request("https://example.com/_vitehub/agents/support/webhooks/channel", { body: JSON.stringify(telegramBody(messageId, text)), method: "POST" })
}

function host(url: string) {
  const state = createLibsqlAgentState({ url })
  const run = vi.fn(() => "ok")
  const adapter = chatAdapter()
  const handler = createChannelWebhookRouteHandler(defineAgent({
    channels: { telegram: telegram({ adapter: () => adapter as never, messages: { concurrency: "queue", lockScope: "thread", state, stream: false, triggerHistory: "none" }, webhooks: { secret: false } }) },
    driver: { run },
  }) as never)
  return { handler, run, state }
}

it("settles a queued delivery that an earlier release fingerprinted in the host locale", async () => {
  const lithuanian = new Intl.Collator("lt")
  const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (this: string, that: string) {
    return lithuanian.compare(this, that)
  })
  const directory = await mkdtemp(join(tmpdir(), "agent-channel-rollout-"))
  const url = `file:${join(directory, "state.sqlite")}`
  try {
    const earlier = host(url)
    await earlier.state.connect()
    expect(await earlier.state.acquireLock("telegram:456", 600_000)).toBeTruthy()
    await expect(earlier.handler(webhook(91_040, "A"), "telegram", { agentName: "support" })).resolves.toMatchObject({ status: 200 })
    const [queued] = await readAgentChannelDeliveries(earlier.state)
    const fixedAlias = `deliveries:payload:${encodeURIComponent(`telegram:${await agentChannelDeliveryPayloadFingerprint(telegramBody(91_040, "A"))}`)}`
    const earlierAlias = `deliveries:payload:${encodeURIComponent("telegram:c6f9225ef20a7a89c4d83d186b14dcc412d03cfb202037b70648b052605cc2aa")}`
    expect(await earlier.state.get(fixedAlias)).toBe(queued!.id)
    expect(await earlier.state.get(earlierAlias)).toBe(queued!.id)
    await earlier.state.delete(fixedAlias)
    await earlier.state.disconnect()

    const upgraded = host(url)
    await upgraded.state.connect()
    try {
      await upgraded.state.forceReleaseLock("telegram:456")
      await expect(upgraded.handler(webhook(91_041, "B"), "telegram", { agentName: "support" })).resolves.toMatchObject({ status: 200 })
      const deliveries = await readAgentChannelDeliveries(upgraded.state)
      expect(upgraded.run).toHaveBeenCalledTimes(2)
      expect(deliveries).toHaveLength(2)
      expect(deliveries.find(delivery => delivery.id === queued!.id)?.status).toBe("completed")
      expect(deliveries.every(delivery => delivery.status === "completed")).toBe(true)
    }
    finally {
      await upgraded.state.disconnect()
    }
  }
  finally {
    localeCompare.mockRestore()
    await rm(directory, { force: true, recursive: true })
  }
})
