import { MockLanguageModelV3 } from "ai/test"
import { afterEach, describe, expect, it, vi } from "vitest"

import { telegram } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"

const originalFetch = globalThis.fetch
const chat = { id: 456, type: "group" }
const user = { first_name: "Maxi", id: 123, is_bot: false }
const bot = { first_name: "ViteHub", id: 7, is_bot: true }
const telegramDate = Math.floor(Date.now() / 1000)
const usage = { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } }

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockTelegramApi() {
  const calls: Array<{ body: Record<string, unknown>, method: string }> = []
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = url.slice(url.lastIndexOf("/") + 1)
    if (method === "getMe") return Response.json({ ok: true, result: { ...bot, username: "vitehub_test_bot" } })
    // SAFETY: The Telegram adapter sends a JSON object body to every Bot API method.
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    calls.push({ body, method })
    if (method === "sendMessage") return Response.json({ ok: true, result: { chat, date: telegramDate, from: bot, message_id: 9_000, text: body.text } })
    if (method === "editMessageText") return Response.json({ ok: true, result: { chat, date: telegramDate, from: bot, message_id: body.message_id, text: body.text } })
    return Response.json({ ok: true, result: true })
  }) as typeof fetch
  return calls
}

const skipReplyCall = {
  content: [{ input: JSON.stringify({ reason: "The message was for another person." }), toolCallId: "skip-1", toolName: "skip_reply", type: "tool-call" as const }],
  finishReason: { raw: "tool_calls", unified: "tool-calls" as const },
  usage,
  warnings: [],
}

function textResponse(text: string) {
  return { content: [{ text, type: "text" as const }], finishReason: { raw: "stop", unified: "stop" as const }, usage, warnings: [] }
}

function silentAgent(allowSilentReply: boolean) {
  const model = new MockLanguageModelV3({ doGenerate: allowSilentReply
    ? [skipReplyCall, textResponse("Text after skip_reply")]
    : [textResponse("Answer")] })
  const invocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })
  const handler = createChannelWebhookRouteHandler(defineAgent({
    channels: {
      telegram: telegram({
        allowedUserIds: [123],
        botToken: "test-token",
        messages: {
          ...(allowSilentReply ? { allowSilentReply: true } : {}),
          durable: false,
          final: { delivery: "placeholder" },
          loading: { text: "Thinking…" },
        },
        mode: "webhook",
        webhookSecret: false,
      }),
    },
    cli: { capabilities: false },
    driver: { model },
    invocations,
    runtime: false,
  }))
  return { handler, invocations, model }
}

async function webhook(handler: ReturnType<typeof createChannelWebhookRouteHandler>, messageId: number) {
  const tasks: Array<Promise<unknown>> = []
  const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
    body: JSON.stringify({ message: { chat, date: telegramDate, from: user, message_id: messageId, text: "@vitehub_test_bot thanks, Anna!" }, update_id: messageId }),
    method: "POST",
  }), "telegram", {
    agentName: "support",
    waitUntil: task => tasks.push(Promise.resolve(task)),
  })
  expect(response.status).toBe(200)
  await Promise.all(tasks)
}

describe("messages.allowSilentReply", () => {
  it("finishes without a reply and removes the placeholder when the Agent calls skip_reply", async () => {
    const calls = mockTelegramApi()
    const { handler, invocations, model } = silentAgent(true)

    await webhook(handler, 8_001)

    expect(model.doGenerateCalls[0]!.tools?.map(tool => tool.name)).toContain("skip_reply")
    const sent = calls.filter(call => call.method === "sendMessage")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body.text).toBe("Thinking…")
    expect(calls.filter(call => call.method === "editMessageText")).toHaveLength(0)
    expect(calls.filter(call => call.method === "deleteMessage")).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ message_id: 9_000 }) }),
    ])
    const page = await invocations.list()
    const record = page.invocations[0] && await invocations.get(page.invocations[0].id)
    expect(record?.status).toBe("completed")
    expect(record?.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "agent.channel.delivery.effect", attributes: expect.objectContaining({
        "channel.effect.intent": "chat.final-reply",
        "channel.effect.kind": "reply",
        "channel.effect.skipped": "skip_reply: The message was for another person.",
      }) }),
    ]))
  })

  it("does not offer skip_reply without the option", async () => {
    const calls = mockTelegramApi()
    const { handler, model } = silentAgent(false)

    await webhook(handler, 8_002)

    expect(model.doGenerateCalls[0]!.tools?.map(tool => tool.name) ?? []).not.toContain("skip_reply")
    expect(calls.filter(call => call.method === "deleteMessage")).toHaveLength(0)
    expect(calls.filter(call => call.method === "editMessageText")).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ message_id: 9_000, rich_message: { markdown: "Answer" } }) }),
    ])
  })

  it("requires messages.loading", () => {
    expect(() => defineAgent({
      channels: { telegram: telegram({ botToken: "test-token", messages: { allowSilentReply: true }, mode: "webhook", webhookSecret: false }) },
      driver: { run: () => "ok" },
      runtime: false,
    })).toThrow("messages.allowSilentReply requires messages.loading")
  })
})
