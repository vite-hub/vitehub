import { createTelegramAdapter } from "@chat-adapter/telegram"
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
    if (url.includes("/getBusinessConnection")) return Response.json({ ok: true, result: { id: "connection", is_enabled: true, rights: { can_reply: true }, user: bot } })
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

function webhook(handler: ReturnType<typeof createChannelWebhookRouteHandler>, messageId: number, text: string, field = "message", updateId = messageId) {
  const tasks: Array<Promise<unknown>> = []
  const response = handler(new Request("https://example.com/_vitehub/agents/support/webhooks/telegram", {
    body: JSON.stringify({
      [field]: {
        chat, date: telegramDate, from: user, message_id: messageId, text,
        ...(field.startsWith("edited_") ? { edit_date: telegramDate } : {}),
        ...(field.includes("business") ? { business_connection_id: "connection" } : {}),
      },
      update_id: updateId,
    }),
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
    // Since #2388 each chat message starts with a readable header that names its message ID.
    expect(promptUserTexts(model.doGenerateCalls[0]!.prompt)).toEqual([
      expect.stringMatching(/^\[[^\]]+ · msg 8101\]\nI had two different things$/),
      expect.stringMatching(/^\[[^\]]+ · msg 8102\]\nBoth!$/),
    ])
    expect(sent).toHaveLength(1)
    expect(JSON.stringify(sent[0])).toContain("One reply")
  })

  it.each([
    { field: "message", provider: "telegram" },
    { field: "edited_channel_post", provider: "telegram" },
    { field: "business_message", provider: "telegram" },
    { field: "edited_business_message", provider: "telegram" },
    { field: "message", provider: "custom" },
    { field: "edited_message", provider: "telegram", duplicate: true },
    { field: "edited_message", provider: "telegram", concurrency: "queue" as const },
    { field: "edited_message", provider: "telegram", concurrency: "serial" as const },
  ])("settles each queued $field delivery ($provider, $concurrency, repeated edit: $duplicate)", async ({ field, provider, duplicate, concurrency }) => {
    mockTelegramApi()
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const state = createLibsqlAgentState({ url: ":memory:" })
    const releaseFirst = deferred<void>()
    const firstHeld = deferred<void>()
    if (duplicate) {
      const dequeue = state.dequeue.bind(state)
      vi.spyOn(state, "dequeue").mockImplementationOnce(async (key) => {
        firstHeld.resolve()
        await releaseFirst.promise
        return await dequeue(key)
      })
    }
    const model = new MockLanguageModelV3({ doGenerate: {
      content: [{ text: "One reply", type: "text" }],
      finishReason: { raw: "stop", unified: "stop" },
      usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } },
      warnings: [],
    } })
    const handler = createChannelWebhookRouteHandler(defineAgent({
      channels: {
        telegram: telegram({
          adapter: () => createTelegramAdapter({ allowedUserIds: [123], allowUnverifiedWebhooks: true, botToken: "test-token", businessMode: field.includes("business"), mode: "webhook" }),
          messages: { concurrency: concurrency ?? "steer", debounceMs: concurrency ? undefined : 100, delivery: "manual", fallbackStreamingPlaceholderText: null, state },
          mode: "webhook",
          webhooks: { id: "telegram", provider, secret: false },
        }),
      },
      driver: { model },
      hooks: {
        async "agent:finish"(event) {
          if (concurrency) {
            firstHeld.resolve()
            await releaseFirst.promise
          }
          return event.reply(event.text ?? "")
        },
      },
      runtime: false,
    }))
    try {
      const first = webhook(handler, 8_201, "I had two different things", field)
      if (duplicate || concurrency) await firstHeld.promise
      if (duplicate) {
        await webhook(handler, 8_201, "Edited", field, 8_203)
        await webhook(handler, 8_201, "I had two different things", field, 8_204)
      }
      const second = webhook(handler, 8_202, "Both!", field)
      if (duplicate || concurrency) {
        await second
        releaseFirst.resolve()
      }
      await Promise.all([first, second])
      expect(model.doGenerateCalls).toHaveLength(concurrency ? 2 : 1)
      const deliveries = await handler.deliveries(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram"), "telegram", { agentName: "support" })
      const outcomes = Object.fromEntries(deliveries.map(delivery => [delivery.sourceId, delivery.status]))
      expect(outcomes).toEqual({ 8201: "completed", 8202: "completed", ...(duplicate ? { 8203: "rejected", 8204: "rejected" } : {}) })
      const started = deliveries.filter(delivery => delivery.events.some(event => event.type === "invocation.started"))
      expect(started.map(delivery => delivery.sourceId).sort()).toEqual(["8201", "8202"])
      expect(new Set(started.map(delivery => delivery.invocationId)).size).toBe(concurrency ? 2 : 1)
    } finally {
      releaseFirst.resolve()
      await state.disconnect()
    }
  })

  it("runs a queued Telegram message whose delivery record is written while the active run releases the lock", async () => {
    mockTelegramApi()
    const { createLibsqlAgentState } = await import("../src/state/sqlite.ts")
    const state = createLibsqlAgentState({ url: ":memory:" })
    const releaseFirst = deferred<void>()
    const firstHeld = deferred<void>()
    const writeHeld = deferred<void>()
    const releaseWrite = deferred<void>()
    // Hold the delivery record of the second update, as a slow State does.
    const setIfNotExists = state.setIfNotExists.bind(state)
    vi.spyOn(state, "setIfNotExists").mockImplementation(async (key, ...rest) => {
      if (key.startsWith("deliveries:source:") && key.includes("8212")) {
        writeHeld.resolve()
        await releaseWrite.promise
      }
      return await setIfNotExists(key, ...rest)
    })
    const model = new MockLanguageModelV3({ doGenerate: {
      content: [{ text: "One reply", type: "text" }],
      finishReason: { raw: "stop", unified: "stop" },
      usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } },
      warnings: [],
    } })
    const handler = createChannelWebhookRouteHandler(defineAgent({
      channels: {
        telegram: telegram({
          adapter: () => createTelegramAdapter({ allowedUserIds: [123], allowUnverifiedWebhooks: true, botToken: "test-token", mode: "webhook" }),
          messages: { concurrency: "queue", delivery: "manual", fallbackStreamingPlaceholderText: null, state },
          mode: "webhook",
          webhooks: { id: "telegram", secret: false },
        }),
      },
      driver: { model },
      hooks: {
        async "agent:finish"(event) {
          firstHeld.resolve()
          await releaseFirst.promise
          return event.reply(event.text ?? "")
        },
      },
      runtime: false,
    }))
    try {
      const first = webhook(handler, 8_211, "First")
      await firstHeld.promise
      const second = webhook(handler, 8_212, "Second")
      await writeHeld.promise
      // The active run finishes and releases the thread lock while the second delivery record is still being written.
      releaseFirst.resolve()
      await first
      releaseWrite.resolve()
      await second
      expect(model.doGenerateCalls).toHaveLength(2)
      const deliveries = await handler.deliveries(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram"), "telegram", { agentName: "support" })
      expect(Object.fromEntries(deliveries.map(delivery => [delivery.sourceId, delivery.status]))).toEqual({ 8211: "completed", 8212: "completed" })
    } finally {
      releaseFirst.resolve()
      releaseWrite.resolve()
      await state.disconnect()
    }
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
      expect.objectContaining({ message: expect.objectContaining({ parts: [
        expect.objectContaining({ id: "message-header", type: "data-chat-message-header" }),
        expect.objectContaining({ text: "Second", type: "text" }),
      ] }) }),
      { mode: "steer" },
    ])
  })
})
