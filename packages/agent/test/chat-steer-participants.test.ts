import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent } from "../src/index.ts"
import { telegram } from "../src/channels.ts"
import { registerAgentInvocationInputHandler } from "../src/internal/agent-invocation-control.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"

const originalFetch = globalThis.fetch
const maxi = { first_name: "Maxi", id: 123, is_bot: false }
const ana = { first_name: "Ana", id: 124, is_bot: false }
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
  let nextMessageId = 9_000
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/getMe")) return Response.json({ ok: true, result: { ...bot, username: "vitehub_test_bot" } })
    if (url.includes("/sendChatAction")) return Response.json({ ok: true, result: true })
    if (url.includes("/sendMessage") || url.includes("/sendRichMessage")) {
      // SAFETY: The Telegram adapter sends a JSON object body to sendMessage.
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({ ok: true, result: { chat: { id: body.chat_id, type: "group" }, date: telegramDate, from: bot, message_id: nextMessageId++, text: body.text } })
    }
    return new Response(`Unexpected Telegram request: ${url}`, { status: 500 })
  }) as typeof fetch
}

function mention(handler: ReturnType<typeof createChannelWebhookRouteHandler>, chatId: number, from: typeof maxi, messageId: number, text: string) {
  const chat = { id: chatId, title: "Support", type: "group" }
  const tasks: Array<Promise<unknown>> = []
  const response = handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
    body: JSON.stringify({ message: { chat, date: telegramDate, from, message_id: messageId, text: `@vitehub_test_bot ${text}` }, update_id: messageId }),
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

function steerAgent(steerFromParticipants: boolean) {
  const started = deferred<void>()
  const released = deferred<void>()
  const sendInput = vi.fn(() => "accepted" as const)
  const invokers: string[] = []
  const run = vi.fn(async ({ invoker, run }: { invoker: { id: string }, run?: { runId?: string } }) => {
    invokers.push(invoker.id)
    const runId = run?.runId
    if (!runId) throw new Error("Expected an invocation run ID")
    const unregister = registerAgentInvocationInputHandler(runId, { sendInput, support: { steer: true } })
    try {
      started.resolve()
      await released.promise
      return "Reply"
    } finally {
      unregister()
    }
  })
  const handler = createChannelWebhookRouteHandler(defineAgent({
    channels: {
      telegram: telegram({
        allowedUserIds: [maxi.id, ana.id],
        botToken: "test-token",
        messages: { concurrency: "steer", delivery: "manual", durable: false, steerFromParticipants },
        mode: "webhook",
        webhookSecret: false,
      }),
    },
    driver: { run },
    runtime: false,
  }))
  return { handler, invokers, released, run, sendInput, started }
}

describe("steerFromParticipants", () => {
  it("steers the active run with a mention from another participant and keeps the first invoker", async () => {
    mockTelegramApi()
    const agent = steerAgent(true)

    const first = mention(agent.handler, -301, maxi, 8_301, "Check the import")
    await agent.started.promise
    const second = mention(agent.handler, -301, ana, 8_302, "Use the March file")
    await vi.waitFor(() => expect(agent.sendInput).toHaveBeenCalledTimes(1))
    agent.released.resolve()
    await Promise.all([first, second])

    expect(agent.run).toHaveBeenCalledTimes(1)
    expect(agent.invokers).toHaveLength(1)
    expect(agent.invokers[0]).toContain(String(maxi.id))
    expect(agent.sendInput.mock.calls[0]).toEqual([
      expect.objectContaining({ message: expect.objectContaining({ parts: expect.arrayContaining([expect.objectContaining({ text: "@vitehub_test_bot Use the March file", type: "text" })]) }) }),
      { mode: "steer" },
    ])
  })

  it("starts a separate run for another participant when the option is off", async () => {
    mockTelegramApi()
    const agent = steerAgent(false)

    const first = mention(agent.handler, -401, maxi, 8_401, "Check the import")
    await agent.started.promise
    const second = mention(agent.handler, -401, ana, 8_402, "Use the March file")
    // The second participant waits for the active run instead of steering it.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(agent.sendInput).not.toHaveBeenCalled()
    agent.released.resolve()
    await Promise.all([first, second])

    expect(agent.sendInput).not.toHaveBeenCalled()
    expect(agent.run).toHaveBeenCalledTimes(2)
    expect(agent.invokers[0]).toContain(String(maxi.id))
    expect(agent.invokers[1]).toContain(String(ana.id))
  })
})
