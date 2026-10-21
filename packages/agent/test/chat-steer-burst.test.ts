import { MockLanguageModelV3 } from "ai/test"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent } from "../src/index.ts"
import { telegram } from "../src/channels.ts"
import { registerAgentInvocationInputHandler } from "../src/internal/agent-invocation-control.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"

const originalFetch = globalThis.fetch
const chat = { id: 456, type: "private" }
const user = { first_name: "Maxi", id: 123, is_bot: false }
const bot = { first_name: "ViteHub", id: 7, is_bot: true }
const telegramDate = Math.floor(Date.now() / 1000)

afterEach(() => {
  globalThis.fetch = originalFetch
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function mockTelegramApi() {
  const sent: Array<Record<string, unknown>> = []
  let nextMessageId = 9_000
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/getMe")) return Response.json({ ok: true, result: { ...bot, username: "vitehub_test_bot" } })
    if (url.includes("/sendChatAction")) return Response.json({ ok: true, result: true })
    if (url.includes("/sendMessage") || url.includes("/sendRichMessage")) {
      // SAFETY: The Telegram adapter sends a JSON object body to sendMessage.
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      sent.push(body)
      return Response.json({ ok: true, result: { chat, date: telegramDate, from: bot, message_id: nextMessageId++, text: body.text } })
    }
    return new Response(`Unexpected Telegram request: ${url}`, { status: 500 })
  }) as typeof fetch
  return sent
}

function webhook(handler: ReturnType<typeof createChannelWebhookRouteHandler>, messageId: number, text: string) {
  const tasks: Array<Promise<unknown>> = []
  const response = handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
    body: JSON.stringify({ message: { chat, date: telegramDate, from: user, message_id: messageId, text }, update_id: messageId }),
    method: "POST",
  }), "telegram", {
    agentName: "support",
    waitUntil: task => tasks.push(Promise.resolve(task)),
  })
  return response.then(async (result) => {
    expect(result.status).toBe(200)
    await Promise.all(tasks)
  })
}

function promptUserTexts(prompt: Array<{ content: unknown, role: string }>) {
  return prompt
    .filter(message => message.role === "user")
    .flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter((part): part is { text: string, type: "text" } => part?.type === "text")
    .map(part => part.text)
}

describe("steer concurrency with debounceMs", () => {
  it("starts one model call and one reply for two messages sent at the same time", async () => {
    const sent = mockTelegramApi()
    const model = new MockLanguageModelV3({ doGenerate: {
      content: [{ text: "One reply", type: "text" }],
      finishReason: { raw: "stop", unified: "stop" },
      usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } },
      warnings: [],
    } })
    const handler = createChannelWebhookRouteHandler(defineAgent({
      channels: {
        telegram: telegram({
          allowedUserIds: [123],
          botToken: "test-token",
          messages: { concurrency: "steer", debounceMs: 100, delivery: "manual", fallbackStreamingPlaceholderText: null },
          mode: "webhook",
          webhookSecret: false,
        }),
      },
      driver: { model },
      hooks: {
        "agent:finish"(event) {
          return event.reply(event.text ?? "")
        },
      },
      runtime: false,
    }))

    await Promise.all([
      webhook(handler, 8_101, "I had two different things"),
      webhook(handler, 8_102, "Both!"),
    ])

    expect(model.doGenerateCalls).toHaveLength(1)
    expect(promptUserTexts(model.doGenerateCalls[0]!.prompt)).toEqual(["I had two different things", "Both!"])
    expect(sent).toHaveLength(1)
    expect(JSON.stringify(sent[0])).toContain("One reply")
  })

  it("keeps concurrent handling without debounceMs, so a second message steers into the active run", async () => {
    mockTelegramApi()
    const started = deferred<void>()
    const released = deferred<void>()
    const sendInput = vi.fn(() => "accepted" as const)
    const run = vi.fn(async (context: { run?: { runId?: string } }) => {
      const runId = context.run?.runId
      if (!runId) throw new Error("Expected an invocation run ID")
      const unregister = registerAgentInvocationInputHandler(runId, { sendInput, support: { steer: true } })
      try {
        started.resolve()
        await released.promise
        return "Steered reply"
      } finally {
        unregister()
      }
    })
    const handler = createChannelWebhookRouteHandler(defineAgent({
      channels: {
        telegram: telegram({
          allowedUserIds: [123],
          botToken: "test-token",
          messages: { concurrency: "steer", delivery: "manual", durable: false },
          mode: "webhook",
          webhookSecret: false,
        }),
      },
      driver: { run },
      runtime: false,
    }))

    const first = webhook(handler, 8_201, "First")
    await started.promise
    const second = webhook(handler, 8_202, "Second")
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1))
    released.resolve()
    await Promise.all([first, second])

    expect(run).toHaveBeenCalledTimes(1)
    expect(sendInput.mock.calls[0]).toEqual([
      expect.objectContaining({ message: expect.objectContaining({ parts: [expect.objectContaining({ text: "Second", type: "text" })] }) }),
      { mode: "steer" },
    ])
  })
})
