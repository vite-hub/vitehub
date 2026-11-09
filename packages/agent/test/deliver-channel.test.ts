import { afterEach, expect, it, vi } from "vitest"

import { telegram } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { deliverChannel } from "../src/test.ts"

const chat = { id: 4_242, type: "private" }
const user = { first_name: "Max", id: 42, is_bot: false }
const bot = { first_name: "Calories", id: 7, is_bot: true }

function replyModel(prompts: unknown[]) {
  return {
    async doGenerate(options: { prompt: unknown }) {
      prompts.push(options.prompt)
      return {
        content: [{ text: "Saved", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
          outputTokens: { reasoning: 0, text: 1, total: 1 },
        },
        warnings: [],
      }
    },
    async doStream() {
      throw new Error("Unexpected streaming model call")
    },
    modelId: "deliver-channel-test",
    provider: "test",
    specificationVersion: "v3",
    supportedUrls: {},
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it("delivers a Telegram update to the Agent and waits for its reply", async () => {
  const prompts: unknown[] = []
  const replies: string[] = []
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/getMe")) return Response.json({ ok: true, result: { ...bot, username: "calories_test_bot" } })
    if (url.includes("/sendChatAction")) return Response.json({ ok: true, result: true })
    if (url.includes("/sendMessage") || url.includes("/sendRichMessage")) {
      const body = JSON.parse(String(init?.body)) as { rich_message?: { markdown?: string }, text?: string }
      replies.push(String(body.rich_message?.markdown ?? body.text))
      return Response.json({ ok: true, result: { chat, date: 1_788_358_001, from: bot, message_id: 900, text: body.text } })
    }
    throw new Error(`Unexpected Telegram request: ${url}`)
  })
  const agent = defineAgent({
    channels: {
      telegram: telegram({
        allowedUserIds: [42],
        botToken: "test-token",
        messages: { delivery: "manual", fallbackStreamingPlaceholderText: null },
        mode: "webhook",
        webhookSecret: "test-secret",
      }),
    },
    // SAFETY: This object implements the AI SDK LanguageModelV3 methods that the Driver calls.
    driver: { model: replyModel(prompts) as never },
    hooks: {
      "agent:finish"(event) {
        return event.reply(event.text ?? "")
      },
    },
    runtime: false,
  })

  const response = await deliverChannel(agent, "telegram", {
    message: { chat, date: 1_788_358_000, from: user, message_id: 101, text: "Two eggs" },
    update_id: 123,
  }, { agentName: "calories", headers: { "x-telegram-bot-api-secret-token": "test-secret" } })

  expect(response.status).toBe(200)
  expect(prompts).toHaveLength(1)
  expect(JSON.stringify(prompts[0])).toContain("Two eggs")
  expect(replies).toEqual(["Saved"])
})

it("returns the Channel's answer to a delivery that fails its check", async () => {
  const agent = defineAgent({
    channels: { telegram: telegram({ botToken: "test-token", mode: "webhook", webhookSecret: "test-secret" }) },
    // SAFETY: The model is never called, because the Channel refuses the delivery first.
    driver: { model: replyModel([]) as never },
    runtime: false,
  })

  const response = await deliverChannel(agent, "telegram", { update_id: 124 }, { headers: { "x-telegram-bot-api-secret-token": "wrong" } })

  expect(response.status).toBe(401)
})
