import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent } from "../src/index.ts"
import { telegram } from "../src/channels.ts"
import { registerAgentInvocationInputHandler } from "../src/internal/agent-invocation-control.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import type { AgentChatWrapUpOptions } from "../src/index.ts"

const originalFetch = globalThis.fetch
const maxi = { first_name: "Maxi", id: 123, is_bot: false }
const bot = { first_name: "ViteHub", id: 7, is_bot: true }
const telegramDate = Math.floor(Date.now() / 1000)

afterEach(() => {
  globalThis.fetch = originalFetch
})

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

function mention(handler: ReturnType<typeof createChannelWebhookRouteHandler>, chatId: number, messageId: number, text: string) {
  const chat = { id: chatId, title: "Support", type: "group" }
  const tasks: Array<Promise<unknown>> = []
  const response = handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/telegram", {
    body: JSON.stringify({ message: { chat, date: telegramDate, from: maxi, message_id: messageId, text: `@vitehub_test_bot ${text}` }, update_id: messageId }),
    method: "POST",
  }), "telegram", {
    agentName: "support",
    waitUntil: task => tasks.push(Promise.resolve(task)),
  })
  return response.then(async (result) => {
    expect(result.status).toBe(200)
    await Promise.allSettled(tasks)
  })
}

/** An Agent whose run only finishes when it is steered, like a Provider Driver turn. */
function slowAgent(timeout: number, wrapUp?: false | AgentChatWrapUpOptions) {
  const sendInput = vi.fn<(input: { prompt?: unknown }, options: { mode: string }) => "accepted">()
  const run = vi.fn(async ({ run }: { run?: { runId?: string } }) => {
    const runId = run?.runId
    if (!runId) throw new Error("Expected an invocation run ID")
    let steered!: (text: string) => void
    const answer = new Promise<string>((resolve) => {
      steered = resolve
    })
    const timeoutHandle = setTimeout(() => steered("Timed out"), timeout)
    const unregister = registerAgentInvocationInputHandler(runId, {
      sendInput: (input) => {
        sendInput(input as { prompt?: unknown }, { mode: "steer" })
        steered("Found the error-tracking issue; the cause is unverified.")
        return "accepted"
      },
      support: { steer: true },
    })
    try {
      return await answer
    }
    finally {
      clearTimeout(timeoutHandle)
      unregister()
    }
  })
  const handler = createChannelWebhookRouteHandler(defineAgent({
    channels: {
      telegram: telegram({
        allowedUserIds: [maxi.id],
        botToken: "test-token",
        messages: { concurrency: "steer", delivery: "manual", durable: false, timeout, ...(wrapUp === undefined ? {} : { wrapUp }) },
        mode: "webhook",
        webhookSecret: false,
      }),
    },
    driver: { run },
    runtime: false,
  }))
  return { handler, run, sendInput }
}

describe("messages.wrapUp", () => {
  it("steers the run to answer before the timeout cancels it", async () => {
    mockTelegramApi()
    const agent = slowAgent(400, { beforeMs: 300 })

    await mention(agent.handler, -501, 8_501, "Why is the connector down?")

    expect(agent.sendInput).toHaveBeenCalledTimes(1)
    expect(agent.sendInput.mock.calls[0]?.[0]).toEqual({ prompt: expect.stringContaining("send your final reply now") })
    // The steered run answers before the 400 ms timeout would cancel it.
    await expect(agent.run.mock.results[0]?.value).resolves.toBe("Found the error-tracking issue; the cause is unverified.")
  })

  it("uses a custom prompt", async () => {
    mockTelegramApi()
    const agent = slowAgent(400, { beforeMs: 300, prompt: "Wrap up." })

    await mention(agent.handler, -502, 8_502, "Why is the connector down?")

    expect(agent.sendInput.mock.calls[0]?.[0]).toEqual({ prompt: "Wrap up." })
  })

  it("does not steer short timeouts by default, or when turned off", async () => {
    mockTelegramApi()
    const short = slowAgent(200)
    const off = slowAgent(400, false)

    await Promise.all([
      mention(short.handler, -503, 8_503, "Why is the connector down?"),
      mention(off.handler, -504, 8_504, "Why is the connector down?"),
    ])

    expect(short.sendInput).not.toHaveBeenCalled()
    expect(off.sendInput).not.toHaveBeenCalled()
  })
})
