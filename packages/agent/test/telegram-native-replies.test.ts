import { createTelegramAdapter } from "@chat-adapter/telegram"
import { afterEach, describe, expect, it, vi } from "vitest"

import { telegram } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"

const originalFetch = globalThis.fetch

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
let nextChatId = 9_000
let nextUpdateId = 1

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Fakes the Telegram Bot API and records each sent message body. */
function fakeTelegramApi() {
  const sent: Array<Record<string, unknown>> = []
  const chat = { id: nextChatId++, type: "private" }
  let nextBotMessageId = 500
  // SAFETY: afterEach restores the original fetch; the fake answers only the Bot API calls these tests make.
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/getMe")) return Response.json({ ok: true, result: { first_name: "ViteHub", id: 7, is_bot: true, username: "vitehub_test_bot" } })
    if (url.includes("/sendChatAction")) return Response.json({ ok: true, result: true })
    if (url.includes("/sendMessage") || url.includes("/sendRichMessage")) {
      const body: Record<string, unknown> = JSON.parse(String(init?.body))
      sent.push(body)
      return Response.json({
        ok: true,
        result: { chat, date: Math.floor(Date.now() / 1000), from: { first_name: "ViteHub", id: 7, is_bot: true }, message_id: nextBotMessageId++, text: body.text },
      })
    }
    return new Response(`Unexpected Telegram request: ${url}`, { status: 500 })
  }) as typeof fetch
  return { chat, sent }
}

async function sendTelegramMessage(agent: ReturnType<typeof defineAgent>, chat: { id: number, type: string }, messageId: number) {
  const tasks: Array<Promise<unknown>> = []
  // SAFETY: This synthetic route call omits host-only context that Telegram webhook handling does not read.
  const response = await createChannelWebhookRouteHandler(agent as never)(
    new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
      body: JSON.stringify({
        message: {
          chat,
          date: Math.floor(Date.now() / 1000),
          from: { first_name: "Maxi", id: 123, is_bot: false },
          message_id: messageId,
          text: "is this meal saved?",
        },
        update_id: nextUpdateId++,
      }),
      method: "POST",
    }),
    "telegram",
    { agentName: "telegram-native-replies", waitUntil: task => tasks.push(Promise.resolve(task)) },
  )
  expect(response.status).toBe(200)
  await Promise.all(tasks)
}

describe("Telegram native replies", () => {
  it.each(["automatic", "manual"] as const)("answers the triggering message with reply_parameters, delivery=%s", async (delivery) => {
    const { chat, sent } = fakeTelegramApi()
    const outbound: unknown[] = []
    const info = vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      const event: unknown = typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : undefined
      if (isRecord(event) && event.scope === "vitehub.channel.delivery" && String(event.type).startsWith("outbound.")) outbound.push(event)
    })
    const agent = defineAgent({
      channels: {
        telegram: telegram({ allowedUserIds: [123], botToken: "test-token", messages: { delivery }, mode: "webhook", webhookSecret: false }),
      },
      driver: { run: () => "Saved." },
      hooks: delivery === "manual" ? { "agent:finish": event => event.reply(event.text ?? "") } : {},
    })

    try {
      await sendTelegramMessage(agent, chat, 8_101)
    } finally {
      info.mockRestore()
    }

    expect(sent).toEqual([{
      chat_id: String(chat.id),
      reply_parameters: { allow_sending_without_reply: true, message_id: 8_101 },
      rich_message: { markdown: "Saved." },
    }])
    // Delivery custody records the reply like a posted message.
    expect(outbound).toContainEqual(expect.objectContaining({ messageId: `${chat.id}:500`, type: "outbound.completed" }))
  })

  it("posts a new message when the adapter cannot reply", async () => {
    const { chat, sent } = fakeTelegramApi()
    const agent = defineAgent({
      channels: {
        telegram: telegram({
          adapter: () => {
            const adapter = createTelegramAdapter({ allowedUserIds: [123], allowUnverifiedWebhooks: true, botToken: "test-token", mode: "webhook" })
            // Simulates a Chat SDK adapter without native replies.
            Reflect.set(adapter, "reply", undefined)
            return adapter
          },
          allowedUserIds: [123],
          botToken: "test-token",
          mode: "webhook",
          webhookSecret: false,
        }),
      },
      driver: { run: () => "Saved." },
    })

    await sendTelegramMessage(agent, chat, 8_102)

    expect(sent).toEqual([{ chat_id: String(chat.id), rich_message: { markdown: "Saved." } }])
  })
})
