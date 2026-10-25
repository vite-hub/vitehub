import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Message } from "chat"
import { afterEach, describe, expect, it, vi } from "vitest"

import { installChannelsConsoleHost } from "../src/channels-console-host.ts"
import { defineChatCapability } from "../src/chat-trigger.ts"
import { defineAgent } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import { agentChannelOperations } from "../src/operations.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

import { parseOperationInput } from "@vite-hub/internal/operations"

import type { OperationContext } from "@vite-hub/internal/operations"
import type { Adapter, ChatInstance, WebhookOptions } from "chat"

const webhookUrl = "https://example.com/api/_vitehub/agents/support/webhooks/telegram"

// Every message runs the chat route with a libSQL State, which takes a moment.
vi.setConfig({ testTimeout: 30_000 })
const photo = Buffer.from([1, 2, 3])

/** A Telegram-shaped adapter. `window` is how many of the newest messages the provider still returns. */
function telegramAdapter(options: { cache?: boolean, window?: number } = {}) {
  let chat: ChatInstance | undefined
  let sent = 0
  const messages: Message[] = []
  const adapter = {
    channelIdFromThreadId: (threadId: string) => threadId,
    editMessage: vi.fn(async (threadId: string, messageId: string, message: unknown) => ({ id: messageId, raw: { message }, threadId })),
    fetchMessages: vi.fn(async (threadId: string) => ({
      messages: messages.filter(message => message.threadId === threadId).slice(Math.max(0, messages.filter(message => message.threadId === threadId).length - (options.window ?? 1000))),
    })),
    handleWebhook: vi.fn(async (request: Request, webhookOptions?: WebhookOptions) => {
      // SAFETY: The test sends the Telegram update shape that this fake reads.
      const body = await request.json() as { message?: Record<string, any> }
      const raw = body.message
      if (!raw || !chat) return Response.json({ ok: true })
      const message = new Message({
        attachments: raw.photo
          ? [{ fetchData: async () => photo, fetchMetadata: { fileId: "photo-1" }, mimeType: "image/jpeg", name: "meal.jpg", size: photo.length, type: "image" }]
          : [],
        author: { fullName: "Maxi", isBot: false, isMe: false, userId: String(raw.from.id), userName: "maxi" },
        formatted: { children: [], type: "root" },
        id: String(raw.message_id),
        metadata: { dateSent: new Date(raw.date * 1000), edited: false },
        raw: body,
        text: raw.text ?? "",
        threadId: `telegram:${raw.chat.id}`,
      })
      messages.push(message)
      // SAFETY: The fake implements the adapter methods that ChatInstance calls.
      await chat.processMessage(adapter as unknown as Adapter, message.threadId, message, webhookOptions)
      return Response.json({ ok: true })
    }),
    initialize: vi.fn(async (instance: ChatInstance) => {
      chat = instance
    }),
    isDM: vi.fn(() => true),
    name: "telegram",
    persistThreadHistory: options.cache ?? true,
    postMessage: vi.fn(async (threadId: string, message: unknown) => {
      const id = `sent-${++sent}`
      messages.push(new Message({
        attachments: [],
        author: { fullName: "vitehub", isBot: true, isMe: true, userId: "self", userName: "vitehub" },
        formatted: { children: [], type: "root" },
        id,
        // The fake clock is the reply time of the last user message plus a second.
        metadata: { dateSent: new Date(new Date((messages.at(-1)?.metadata.dateSent ?? new Date()).getTime() + 1000)), edited: false },
        raw: { message },
        text: typeof message === "string" ? message : String((message as { markdown?: string }).markdown ?? ""),
        threadId,
      }))
      return { id, raw: { message }, threadId }
    }),
    rehydrateAttachment: (attachment: unknown) => ({ ...(attachment as object), fetchData: async () => photo }),
    startTyping: vi.fn(async () => {}),
    userName: "vitehub",
  }
  return Object.assign(adapter, { messages })
}

interface Fixture {
  adapter: ReturnType<typeof telegramAdapter>
  /** The route handler that the generated webhook route calls. */
  history: (threadId: string) => Promise<Response>
  say: (id: number, text: string, extra?: Record<string, unknown>, chat?: number) => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(options: { cache?: boolean, content?: boolean, durable: boolean, window?: number }): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-conversation-"))
  cleanups.push(() => rm(directory, { force: true, recursive: true }))
  const state = createLibsqlAgentState({ url: `file:${join(directory, "state.sqlite")}` })
  const adapter = telegramAdapter({ ...(options.cache === undefined ? {} : { cache: options.cache }), ...(options.window === undefined ? {} : { window: options.window }) })
  let turn = 0
  const agent = defineAgent({
    capabilities: [
      defineChatCapability({
        // SAFETY: The fake implements the Adapter methods that the chat route calls.
        platforms: { telegram: () => adapter as unknown as Adapter },
        stream: false,
        ...(options.durable ? { transcripts: { maxPerUser: 100 } } : {}),
        webhooks: { telegram: { secretHeader: "x-test-secret", secretToken: "history-secret" } },
      }),
    ],
    driver: { run: () => ({ text: `reply ${++turn}` }) },
    invocations: defineAgentInvocations({ ...(options.content ? { content: "content" as const } : {}), store: createMemoryAgentInvocationStore() }),
    name: "support",
    runtime: false,
  })
  // SAFETY: The test agent has the shape that the route handler reads.
  const handler = createChannelWebhookRouteHandler(agent as never)
  installChannelsConsoleHost({
    agents: { support: agent },
    // The handler is the one that the generated route module installs.
    handlers: { support: handler },
    options: () => ({ agentIdentity: { name: "support" }, state }),
  })
  return {
    adapter,
    history: threadId => handler(new Request(webhookUrl, {
      body: JSON.stringify({ threadId }),
      headers: { "content-type": "application/json", "x-test-secret": "history-secret", "x-vitehub-channel-history": "1" },
      method: "POST",
    }), "telegram", { agentIdentity: { name: "support" }, state }),
    async say(id, text, extra = {}, chat = 456) {
      const before = adapter.messages.length
      const response = await handler(new Request(webhookUrl, {
        body: JSON.stringify({ message: { chat: { id: chat, type: "private" }, date: 1781092800 + id * 60, from: { id: chat, username: "maxi" }, message_id: id, text, ...extra }, update_id: id }),
        headers: { "x-test-secret": "history-secret" },
        method: "POST",
      }), "telegram", { agentIdentity: { name: "support" }, state })
      expect(response.status).toBe(200)
      // An app that keeps transcripts appends what it saw and what it said, as Chat SDK documents.
      if (options.durable) {
        await state.connect()
        for (const message of adapter.messages.slice(before)) {
          await state.appendToList(`chat:support:transcripts:user:telegram:${chat}`, {
            id: crypto.randomUUID(),
            platform: "telegram",
            platformMessageId: message.id,
            role: message.author.isMe ? "assistant" : "user",
            text: message.text,
            threadId: message.threadId,
            timestamp: message.metadata.dateSent.getTime(),
            userKey: `telegram:${chat}`,
          }, { maxLength: 100 })
        }
      }
    },
  }
}

function operation(name: string) {
  const found = agentChannelOperations.find(candidate => candidate.name === name)
  if (!found) throw new Error(`No operation ${name}`)
  return async (input: unknown) => {
    const context: OperationContext = { access: { mode: "open", sections: "all" }, request: new Request("http://vitehub.local/_vitehub/rpc/__call"), surface: "console", user: null }
    // SAFETY: Each test reads fields of the result that the operation documents.
    return await (found.run as (input: unknown, context: OperationContext) => Promise<any>)(await parseOperationInput(found, input), context)
  }
}

describe("Channel conversation operations", () => {
  it("belongs to the channels section, with a name per surface", () => {
    expect(agentChannelOperations.map(candidate => [candidate.name, candidate.section, candidate.kind])).toEqual([
      ["channels.list", "channels", "read"],
      ["channels.threads", "channels", "read"],
      ["channels.conversation", "channels", "read"],
      ["conversations.export", "channels", "read"],
    ])
  })

  it("lists the Channels with the provider and how long each keeps its messages", async () => {
    await fixture({ durable: false })
    await expect(operation("channels.list")({})).resolves.toMatchObject({
      channels: [{ agent: "support", channel: "telegram", conversations: true, provider: "telegram", retention: { durable: false, maxMessages: 100, mode: "provider-window", warning: expect.stringContaining("100 messages for 7 days") } }],
    })
    await fixture({ durable: true })
    await expect(operation("channels.list")({})).resolves.toMatchObject({
      channels: [{ retention: { durable: true, mode: "durable-transcripts", transcripts: true } }],
    })
  })

  it("lists the threads of a Channel with title, people, last message, and count", async () => {
    const chat = await fixture({ durable: false })
    await chat.say(1, "hello")
    await chat.say(3, "other chat", {}, 789)
    const threads = await operation("channels.threads")({ agent: "support", channel: "telegram" })
    expect(threads.threads.map((thread: { thread: string }) => thread.thread).sort()).toEqual(["telegram:456", "telegram:789"])
    const first = threads.threads.find((thread: { thread: string }) => thread.thread === "telegram:456")
    expect(first).toMatchObject({ invocationCount: 1, messageCount: 2, participants: ["Maxi"] })
    expect(first.lastMessageAt).toEqual(expect.any(String))
    const paged = await operation("channels.threads")({ agent: "support", channel: "telegram", limit: 1 })
    expect(paged.threads).toHaveLength(1)
    expect(paged.nextCursor).toBe("1")
    const next = await operation("channels.threads")({ agent: "support", channel: "telegram", cursor: paged.nextCursor, limit: 1 })
    expect(next.threads).toHaveLength(1)
    expect(next.nextCursor).toBeUndefined()
    expect(next.threads[0].thread).not.toBe(paged.threads[0].thread)
  })

  it("stitches the provider window, the transcripts, and the Invocations without a message twice", async () => {
    // The provider only returns the newest two messages, so the rest must come from the durable transcripts.
    const chat = await fixture({ cache: false, durable: true, window: 2 })
    await chat.say(1, "first question")
    await chat.say(3, "second question")
    await chat.say(5, "third question")
    const conversation = await operation("channels.conversation")({ agent: "support", channel: "telegram", thread: "telegram:456" })
    expect(conversation.retention).toMatchObject({ durable: true, mode: "durable-transcripts" })
    const lines = conversation.messages.map((message: { role: string, text: string }) => `${message.role}: ${message.text}`)
    expect(lines).toEqual([
      "user: first question",
      "assistant: reply 1",
      "user: second question",
      "assistant: reply 2",
      "user: third question",
      "assistant: reply 3",
    ])
    expect(new Set(conversation.messages.map((message: { id: string }) => message.id)).size).toBe(conversation.messages.length)
    // Every reply names the Invocation that sent it, and so does the message that started it.
    for (const message of conversation.messages) expect(message.invocationId, message.text).toEqual(expect.any(String))
    expect(conversation.messages[1].invocationId).toBe(conversation.messages[0].invocationId)
    expect(conversation.messages[1].invocationId).not.toBe(conversation.messages[3].invocationId)
    expect(conversation.messages.map((message: { source: string }) => message.source)).toContain("transcript")
    // The oldest messages come from the transcript, which keeps no names. The newest come from the provider.
    expect(conversation.messages[0].author).toMatchObject({ id: "456" })
    expect(conversation.messages[4].author).toMatchObject({ name: "Maxi" })
    const times = conversation.messages.map((message: { at: string }) => message.at)
    expect([...times].sort()).toEqual(times)
  })

  it("keeps an answer that only an Invocation remembers", async () => {
    // No transcripts and a provider that returns nothing: the Invocation is the only record, because its journal keeps content.
    const chat = await fixture({ cache: false, content: true, durable: false, window: 0 })
    await chat.say(1, "question")
    const conversation = await operation("channels.conversation")({ agent: "support", channel: "telegram", thread: "telegram:456" })
    expect(conversation.retention.warning).toContain("Transcripts are not durable")
    expect(conversation.messages.map((message: { role: string, source: string, text: string }) => `${message.role}/${message.source}: ${message.text}`)).toEqual([
      "user/invocation: question",
      "assistant/invocation: reply 1",
    ])
    expect(conversation.messages[0].invocationId).toBe(conversation.messages[1].invocationId)
    // The same Invocation does not add what the provider still has.
    const again = await fixture({ content: true, durable: false })
    await again.say(1, "question")
    const full = await operation("channels.conversation")({ agent: "support", channel: "telegram", thread: "telegram:456" })
    expect(full.messages.map((message: { source: string }) => message.source)).toEqual(["provider", "provider"])
  })

  it("pages a conversation with a cursor", async () => {
    const chat = await fixture({ durable: false })
    for (let id = 1; id <= 5; id += 2) await chat.say(id, `question ${id}`)
    const first = await operation("channels.conversation")({ agent: "support", channel: "telegram", limit: 4, thread: "telegram:456" })
    expect(first.messages).toHaveLength(4)
    expect(first.messageCount).toBe(6)
    const second = await operation("channels.conversation")({ agent: "support", channel: "telegram", cursor: first.nextCursor, limit: 4, thread: "telegram:456" })
    expect(second.messages).toHaveLength(2)
    expect(second.nextCursor).toBeUndefined()
    await expect(operation("channels.conversation")({ agent: "support", channel: "telegram", cursor: "nope", thread: "telegram:456" })).rejects.toMatchObject({ code: "CHANNELS_CURSOR_INVALID" })
  })

  it("fails with a coded error for an unknown Agent or Channel", async () => {
    await fixture({ durable: false })
    await expect(operation("channels.conversation")({ agent: "ghost", channel: "telegram", thread: "t" })).rejects.toMatchObject({ code: "CHANNELS_NOT_FOUND", status: 404 })
    await expect(operation("channels.conversation")({ agent: "support", channel: "ghost", thread: "t" })).rejects.toMatchObject({ code: "CHANNELS_NOT_FOUND", status: 404 })
  })
})

describe("conversations.export", () => {
  it("exports Markdown with author and time headers, and attachment links", async () => {
    const chat = await fixture({ durable: false })
    await chat.say(1, "what is in this meal?", { photo: [{ file_id: "photo-1", file_name: "meal.jpg", file_size: 3 }] })
    const withMedia = await operation("conversations.export")({ agent: "support", channel: "telegram", format: "markdown", media: true, thread: "telegram:456" })
    expect(withMedia).toMatchObject({ filename: "telegram-456.md", format: "markdown", messageCount: 2, mimeType: "text/markdown" })
    expect(withMedia.text).toMatch(/^# Conversation telegram:456\n/)
    expect(withMedia.text).toContain("### Maxi · 2026-06-10 ")
    expect(withMedia.text).toContain("### Agent · ")
    expect(withMedia.text).toContain("what is in this meal?")
    expect(withMedia.text).toContain("- Attachment: [meal.jpg](media/0001-meal.jpg)")
    expect(withMedia.text).toContain("Warning: transcripts are not durable")
    expect(withMedia.media).toEqual([{ base64: photo.toString("base64"), mimeType: "image/jpeg", path: "media/0001-meal.jpg", size: 3 }])
    const withoutMedia = await operation("conversations.export")({ agent: "support", channel: "telegram", format: "markdown", thread: "telegram:456" })
    expect(withoutMedia.media).toEqual([])
    expect(withoutMedia.text).toContain("- Attachment: meal.jpg (not included)")
  })

  it("exports the JSON archive of schema version 1 with files in place of data", async () => {
    const chat = await fixture({ durable: true })
    await chat.say(1, "photo", { photo: [{ file_id: "photo-1", file_name: "meal.jpg", file_size: 3 }] })
    const exported = await operation("conversations.export")({ agent: "support", channel: "telegram", format: "json", media: true, thread: "telegram:456" })
    expect(exported).toMatchObject({ filename: "history.json", format: "json", mimeType: "application/json" })
    const archive = JSON.parse(exported.text)
    expect(archive).toMatchObject({
      agent: "support",
      channel: "telegram",
      provider: "telegram",
      retention: { durable: true, maxMessages: 100, ttlMs: 604_800_000 },
      schemaVersion: 1,
      threadId: "telegram:456",
    })
    expect(archive.exportedAt).toEqual(expect.any(String))
    const first = archive.messages[0]
    expect(first).toMatchObject({ id: "1", role: "user", source: "provider", text: "photo", threadId: "telegram:456" })
    expect(first.attachments[0]).toMatchObject({ file: "media/0001-meal.jpg", name: "meal.jpg", type: "image" })
    expect(first.attachments[0]).not.toHaveProperty("data")
    expect(exported.media.map((file: { path: string }) => file.path)).toEqual(["media/0001-meal.jpg"])
  })

  it("serves the same archive from the signed channels history route", async () => {
    const chat = await fixture({ durable: false })
    await chat.say(1, "hello", { photo: [{ file_id: "photo-1", file_name: "meal.jpg", file_size: 3 }] })
    const response = await chat.history("telegram:456")
    expect(response.status).toBe(200)
    // SAFETY: The route answers with the archive that the test reads below.
    const signed = await response.json() as Record<string, any>
    // `channels history` keeps the attachment data in the answer, and the CLI moves it into files.
    expect(signed.messages[0].attachments[0]).toMatchObject({ data: photo.toString("base64"), name: "meal.jpg" })
    expect(signed).toMatchObject({ agent: "support", channel: "telegram", provider: "telegram", schemaVersion: 1, threadId: "telegram:456" })
    const exported = JSON.parse((await operation("conversations.export")({ agent: "support", channel: "telegram", format: "json", media: true, thread: "telegram:456" })).text)
    const strip = (messages: Array<Record<string, any>>) => messages.map(({ attachments, ...message }) => ({ ...message, attachments: attachments.map(({ data: _data, file: _file, ...attachment }: Record<string, unknown>) => attachment) }))
    expect(strip(exported.messages)).toEqual(strip(signed.messages))
    expect(exported.retention).toEqual(signed.retention)
    expect(signed.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"])
  })
})
