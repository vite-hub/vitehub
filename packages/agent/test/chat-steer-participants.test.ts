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

function mention(handler: ReturnType<typeof createChannelWebhookRouteHandler>, chatId: number, from: typeof maxi, messageId: number, text: string, replyTo?: { from: typeof maxi, messageId: number, text: string }) {
  return post(handler, chatId, from, messageId, `@vitehub_test_bot ${text}`, replyTo)
}

function post(handler: ReturnType<typeof createChannelWebhookRouteHandler>, chatId: number, from: typeof maxi, messageId: number, text: string, replyTo?: { from: typeof maxi, messageId: number, text: string }) {
  const chat = { id: chatId, title: "Support", type: "group" }
  const tasks: Array<Promise<unknown>> = []
  const reply = replyTo ? { reply_to_message: { chat, date: telegramDate, from: replyTo.from, message_id: replyTo.messageId, text: replyTo.text } } : {}
  const response = handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
    body: JSON.stringify({ message: { chat, date: telegramDate, from, message_id: messageId, text, ...reply }, update_id: messageId }),
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

function steerAgent(steerFromParticipants: boolean, triggerHistory?: { maxMessages: number, source: "thread" }) {
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
        messages: { concurrency: "steer", delivery: "manual", durable: false, steerFromParticipants, ...(triggerHistory ? { triggerHistory } : {}) },
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

  it("quotes the message that a steering reply answers, because the active run has not seen it", async () => {
    mockTelegramApi()
    const agent = steerAgent(true, { maxMessages: 2, source: "thread" })

    const first = mention(agent.handler, -501, maxi, 8_501, "Check the import")
    await agent.started.promise
    // This message enters the thread after the run started, so the run's input does not have it.
    const middle = post(agent.handler, -501, ana, 8_502, "The value is 73")
    const second = mention(agent.handler, -501, ana, 8_503, "Use this value", { from: ana, messageId: 8_502, text: "The value is 73" })
    await vi.waitFor(() => expect(agent.sendInput).toHaveBeenCalledTimes(1))
    agent.released.resolve()
    await Promise.all([first, middle, second])

    const [input] = agent.sendInput.mock.calls[0] as unknown as [{ message: { parts: Array<{ data?: { modelText?: string }, type: string }> } }]
    const replyLine = input.message.parts.find(part => part.type === "data-chat-reply-context")?.data?.modelText
    expect(replyLine).toContain("\"The value is 73\"")
    expect(replyLine).not.toContain("(shown above)")
  })

  it("starts a separate run for another participant when the option is off", async () => {
    mockTelegramApi()
    const info = vi.spyOn(console, "info")
    const agent = steerAgent(false)

    const first = mention(agent.handler, -401, maxi, 8_401, "Check the import")
    await agent.started.promise
    const second = mention(agent.handler, -401, ana, 8_402, "Use the March file")
    // The second participant waits for the active run instead of steering it. The route polls
    // the active run every 50 ms while it waits.
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(agent.sendInput).not.toHaveBeenCalled()
    agent.released.resolve()
    await Promise.all([first, second])

    expect(agent.sendInput).not.toHaveBeenCalled()
    expect(agent.run).toHaveBeenCalledTimes(2)
    expect(agent.invokers[0]).toContain(String(maxi.id))
    expect(agent.invokers[1]).toContain(String(ana.id))
    // One deferral event for the whole wait, not one for each poll.
    const deferred = info.mock.calls.flatMap(([line]) => typeof line === "string" && line.includes("\"steer.deferred\"") ? [JSON.parse(line)] : [])
    expect(deferred).toEqual([expect.objectContaining({ reason: "not-invoker", runId: expect.any(String), scope: "vitehub.channel.delivery", sourceId: "8402" })])
    info.mockRestore()
  })
})
