import { afterEach, describe, expect, it, vi } from "vitest"

import { telegram } from "../src/channels.ts"
import { defineAgent, runAgent } from "../src/index.ts"
import { createMessage } from "../src/messages.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"

import type { AgentChannelDefinition } from "../src/index.ts"

type Prompt = Array<{ content: string | Array<{ text?: string, type: string }>, role: string }>
type MessageOptions = NonNullable<Parameters<typeof telegram>[0]>["messages"]

// 18:06:29 in Stockholm on 13 October 2026 is 16:06:29 UTC.
const at = (hour: number, minute: number, second = 0) => Date.UTC(2026, 9, 13, hour - 2, minute, second) / 1_000
const user = { first_name: "Max", id: 42, is_bot: false }
const bot = { first_name: "Calories", id: 7, is_bot: true }
const photo = (uniqueId: string) => [{ file_id: `file-${uniqueId}`, file_size: 3, file_unique_id: uniqueId, height: 480, width: 640 }]

function turns(prompt: Prompt, role = "user") {
  return prompt.filter(message => message.role === role).map((message) => {
    const content = typeof message.content === "string" ? [{ text: message.content, type: "text" }] : message.content
    return {
      images: content.filter(part => part.type === "file" || part.type === "image").length,
      text: content.filter(part => part.type === "text").map(part => part.text).join("\n"),
    }
  })
}

// Chat state outlives each handler, so every harness uses its own chat and update ids.
let nextChatId = 1_000
let nextUpdateId = 1
let nextBotMessageId = 200_000

function promptModel(prompts: Prompt[]) {
  return {
    async doGenerate(options: { prompt: Prompt }) {
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
    modelId: "chat-message-context-test",
    provider: "test",
    specificationVersion: "v3",
    supportedUrls: {},
  }
}

function telegramHarness(messages: MessageOptions = {}) {
  const prompts: Prompt[] = []
  const downloads: string[] = []
  const chat = { id: nextChatId++, type: "private" }
  const model = promptModel(prompts)
  const channel: AgentChannelDefinition = telegram({
    allowedUserIds: [42],
    botToken: "test-token",
    messages: { delivery: "manual", fallbackStreamingPlaceholderText: null, lockScope: "channel", ...messages },
    mode: "webhook",
    webhookSecret: "test-secret",
  })
  const agent = defineAgent({
    channels: { telegram: channel },
    // SAFETY: This object implements the AI SDK LanguageModelV3 methods that the Driver calls.
    driver: { model: model as never },
    hooks: {
      "agent:finish"(event) {
        return event.reply(event.text ?? "")
      },
    },
    runtime: false,
  })
  const handler = createChannelWebhookRouteHandler(agent)

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/getMe")) return Response.json({ ok: true, result: { ...bot, username: "calories_test_bot" } })
    if (url.includes("/getFile")) {
      downloads.push(String(JSON.parse(String(init?.body)).file_id))
      return Response.json({ ok: true, result: { file_path: "photos/meal.jpg" } })
    }
    if (url.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } })
    if (url.includes("/sendChatAction")) return Response.json({ ok: true, result: true })
    if (url.includes("/sendMessage") || url.includes("/sendRichMessage")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        ok: true,
        result: { chat, date: at(18, 7), from: bot, message_id: nextBotMessageId++, text: body.text },
      })
    }
    throw new Error(`Unexpected Telegram test request: ${url}`)
  })

  async function send(message: Record<string, unknown>) {
    const tasks: Promise<unknown>[] = []
    const response = await handler(new Request("https://example.test/api/_vitehub/agents/calories/webhooks/telegram", {
      body: JSON.stringify({ message: { chat, from: user, ...message }, update_id: nextUpdateId++ }),
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "test-secret" },
      method: "POST",
    }), "telegram", {
      agentName: "calories",
      runtime: "unknown",
      waitUntil(task) {
        tasks.push(Promise.resolve(task))
      },
    })
    expect(response.status).toBe(200)
    await Promise.all(tasks)
  }

  return { chat, downloads, prompts, send }
}

const recentHistory = { maxAgeMs: 30 * 60 * 1_000, maxImages: 3, maxMessages: 20, source: "thread" } as const

describe("chat trigger message context", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("gives each user message a header with its local send time and photo id", async () => {
    const harness = telegramHarness({ timeZone: "Europe/Stockholm", triggerHistory: recentHistory })

    await harness.send({ date: at(18, 6, 29), message_id: 109311, photo: photo("LEMON-CLEAR") })
    await harness.send({ date: at(18, 27), message_id: 109320, photo: photo("LEMON-RED") })

    expect(turns(harness.prompts[1]!)).toEqual([
      { images: 1, text: "[Tue 2026-10-13 18:06:29 +02:00 · msg 109311 · photo LEMON-CLEAR]" },
      { images: 1, text: "[Tue 2026-10-13 18:27:00 +02:00 · msg 109320 · photo LEMON-RED]" },
    ])
  })

  it("sends only the newest maxImages history photos and names the others as not shown", async () => {
    const harness = telegramHarness({ timeZone: "Europe/Stockholm", triggerHistory: recentHistory })

    for (const [index, name] of ["BANANA", "NACHOS", "SANDWICH", "LEMON"].entries()) {
      await harness.send({ date: at(18, 6 + index), message_id: 109312 + index, photo: photo(name) })
    }
    harness.downloads.length = 0
    await harness.send({ date: at(18, 12), message_id: 109316, text: "the banana was half" })

    expect(turns(harness.prompts.at(-1)!)).toEqual([
      { images: 0, text: "[Tue 2026-10-13 18:06:00 +02:00 · msg 109312 · photo BANANA (not shown)]" },
      { images: 1, text: "[Tue 2026-10-13 18:07:00 +02:00 · msg 109313 · photo NACHOS]" },
      { images: 1, text: "[Tue 2026-10-13 18:08:00 +02:00 · msg 109314 · photo SANDWICH]" },
      { images: 1, text: "[Tue 2026-10-13 18:09:00 +02:00 · msg 109315 · photo LEMON]" },
      { images: 0, text: "[Tue 2026-10-13 18:12:00 +02:00 · msg 109316]\nthe banana was half" },
    ])
    expect(harness.downloads.sort()).toEqual(["file-LEMON", "file-NACHOS", "file-SANDWICH"])
  })

  it("does not send history photos older than maxAgeMs", async () => {
    const harness = telegramHarness({ timeZone: "Europe/Stockholm", triggerHistory: { ...recentHistory, maxAgeMs: 60 * 60 * 1_000, maxImages: 3 } })

    await harness.send({ date: at(16, 0), message_id: 109300, photo: photo("BREAKFAST") })
    await harness.send({ date: at(18, 0), message_id: 109301, text: "and lunch" })

    expect(turns(harness.prompts.at(-1)!)).toEqual([
      { images: 0, text: "[Tue 2026-10-13 18:00:00 +02:00 · msg 109301]\nand lunch" },
    ])
  })

  it("renders a reply as one readable line instead of JSON", async () => {
    const harness = telegramHarness({ timeZone: "Europe/Stockholm" })

    await harness.send({
      date: at(21, 6, 12),
      message_id: 109331,
      reply_to_message: {
        chat: harness.chat,
        date: at(18, 7, 40),
        from: bot,
        message_id: 109315,
        text: "Should I log   the nachos,\nthe banana, or both?",
      },
      text: "Both!",
    })

    expect(turns(harness.prompts[0]!).at(-1)!.text.split("\n")).toEqual([
      "[Tue 2026-10-13 21:06:12 +02:00 · msg 109331]",
      "↪ replying to your msg 109315 (Tue 18:07): \"Should I log the nachos, the banana, or both?\"",
      "Both!",
    ])
    expect(JSON.stringify(harness.prompts[0])).not.toMatch(/reply_to_message|"kind"|"modelText"/)
  })

  it("keeps history photos out of model input and uses UTC when the options are absent", async () => {
    const harness = telegramHarness({ triggerHistory: { maxMessages: 20, source: "thread" } })

    await harness.send({ date: at(18, 6), message_id: 109350, photo: photo("SALAD") })
    harness.downloads.length = 0
    await harness.send({ date: at(18, 8), message_id: 109351, text: "with dressing" })

    expect(turns(harness.prompts.at(-1)!)).toEqual([
      { images: 0, text: "[Tue 2026-10-13 16:06:00 +00:00 · msg 109350 · photo SALAD (not shown)]\nSent an image attachment." },
      { images: 0, text: "[Tue 2026-10-13 16:08:00 +00:00 · msg 109351]\nwith dressing" },
    ])
    expect(harness.downloads).toEqual([])
  })

  it("uses UTC when the time zone is invalid", async () => {
    const harness = telegramHarness({ timeZone: "Mars/Olympus" })

    await harness.send({ date: at(18, 6), message_id: 109360, text: "toast" })

    expect(turns(harness.prompts[0]!)).toEqual([{ images: 0, text: "[Tue 2026-10-13 16:06:00 +00:00 · msg 109360]\ntoast" }])
  })

  it("resolves current attachments first and drops only a history attachment that cannot be read", async () => {
    const prompts: Prompt[] = []
    const agent = defineAgent({
      // SAFETY: This object implements the AI SDK LanguageModelV3 methods that the Driver calls.
      driver: { execution: { attachments: { maxBytes: 6 } }, model: promptModel(prompts) as never },
    })
    const failingHistory = vi.fn(async () => {
      throw new Error("expired file")
    })
    const overBudgetHistory = vi.fn(async () => new Uint8Array([7, 8, 9, 10]))
    const current = vi.fn(async () => new Uint8Array([1, 2, 3]))

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      context: { channel: { message: { id: "current", text: "" } } },
      messages: [
        createMessage({ id: "older", parts: [{ fetchData: failingHistory, mediaType: "image/jpeg", type: "image" }, { text: "older", type: "text" }], role: "user" }),
        createMessage({ id: "old", parts: [{ fetchData: overBudgetHistory, mediaType: "image/jpeg", type: "image" }, { text: "old", type: "text" }], role: "user" }),
        createMessage({ id: "current", parts: [{ fetchData: current, mediaType: "image/jpeg", type: "image" }, { text: "now", type: "text" }], role: "user" }),
      ],
    })).resolves.toMatchObject({ text: "Saved" })

    expect(failingHistory).toHaveBeenCalledOnce()
    expect(overBudgetHistory).toHaveBeenCalledOnce()
    expect(turns(prompts[0]!)).toEqual([
      { images: 0, text: "older" },
      { images: 0, text: "old" },
      { images: 1, text: "now" },
    ])
  })
})
