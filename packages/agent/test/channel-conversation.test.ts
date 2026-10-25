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
import { createCloudflareAgentState } from "../src/state/providers/cloudflare.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"
import { createFakeCloudflareStateNamespace } from "./support/cloudflare-state-namespace.ts"

import { parseOperationInput } from "@vite-hub/internal/operations"

import type { OperationContext } from "@vite-hub/internal/operations"
import type { Adapter, ChatInstance, WebhookOptions } from "chat"

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }))

const webhookUrl = "https://example.com/api/_vitehub/agents/support/webhooks/telegram"

// Every message runs the chat route with a libSQL State, which takes a moment.
vi.setConfig({ testTimeout: 30_000 })
const photo = Buffer.from([1, 2, 3])

/** A Telegram-shaped adapter. `window` is how many of the newest messages the provider still returns. */
function telegramAdapter(options: { cache?: boolean, name?: string, window?: number } = {}) {
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
          : raw.document
            ? [{ mimeType: raw.document.mime_type, name: raw.document.file_name, size: raw.document.file_size, type: "file", url: raw.document.url }]
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
    name: options.name ?? "telegram",
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
  /** The route handler that the generated webhook route calls, asked for the signed history. */
  history: (threadId: string) => Promise<Response>
  state: ReturnType<typeof createLibsqlAgentState>
  say: (id: number, text: string, extra?: Record<string, unknown>, chat?: number) => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

// The route keeps its in-process State per Agent name, so a message id is a duplicate in the next test that uses it.
let memoryFixtures = 0

interface FixtureOptions {
  adapterName?: string
  cache?: boolean
  content?: boolean
  /** `libsql` (the default) and `cloudflare` are durable. `memory` uses the in-process State of the route. */
  state?: "cloudflare" | "libsql" | "memory"
  /** Sets `channels.telegram.transcripts`. */
  transcripts?: false | { maxPerUser?: number }
  window?: number
  journalFails?: boolean
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  // Messages, transcripts, and Invocations all read this clock, which moves one minute for each message.
  vi.useFakeTimers({ toFake: ["Date"] })
  const idOffset = (options.state === "memory" ? ++memoryFixtures : 0) * 10_000
  const directory = await mkdtemp(join(tmpdir(), "vitehub-conversation-"))
  cleanups.push(() => rm(directory, { force: true, recursive: true }))
  const kind = options.state ?? "libsql"
  const libsql = createLibsqlAgentState({ url: `file:${join(directory, "state.sqlite")}` })
  const state = kind === "cloudflare" ? createCloudflareAgentState({ namespace: createFakeCloudflareStateNamespace() }) : kind === "libsql" ? libsql : undefined
  const adapter = telegramAdapter({ ...(options.adapterName ? { name: options.adapterName } : {}), ...(options.cache === undefined ? {} : { cache: options.cache }), ...(options.window === undefined ? {} : { window: options.window }) })
  let turn = 0
  const invocations = defineAgentInvocations({ ...(options.content ? { content: "content" as const } : {}), store: createMemoryAgentInvocationStore() })
  const agent = defineAgent({
    capabilities: [
      defineChatCapability({
        // SAFETY: The fake implements the Adapter methods that the chat route calls.
        platforms: { telegram: () => adapter as unknown as Adapter },
        stream: false,
        ...(options.transcripts !== undefined ? { transcripts: options.transcripts as never } : {}),
        webhooks: { telegram: { secretHeader: "x-test-secret", secretToken: "history-secret" } },
      }),
    ],
    driver: { run: () => ({ text: `reply ${++turn}` }) },
    invocations,
    name: "support",
    runtime: false,
  })
  // SAFETY: The test agent has the shape that the route handler reads.
  const handler = createChannelWebhookRouteHandler(agent as never)
  const routeOptions = { agentIdentity: { name: "support" }, ...(state ? { state } : {}) }
  installChannelsConsoleHost({
    agents: { support: agent },
    // The handler is the one that the generated route module installs.
    handlers: { support: handler },
    options: () => routeOptions,
  })
  return {
    adapter,
    history: threadId => {
      if (options.journalFails) invocations.list = async () => { throw new Error("journal down") }
      return handler(new Request(webhookUrl, {
        body: JSON.stringify({ threadId }),
        headers: { "content-type": "application/json", "x-test-secret": "history-secret", "x-vitehub-channel-history": "1" },
        method: "POST",
      }), "telegram", routeOptions)
    },
    async say(id, text, extra = {}, chat = 456) {
      vi.setSystemTime(new Date(Date.parse("2026-06-10T12:00:00.000Z") + id * 60_000))
      const response = await handler(new Request(webhookUrl, {
        body: JSON.stringify({ message: { chat: { id: chat, type: "private" }, date: Math.floor(Date.now() / 1000), from: { id: chat, username: "maxi" }, message_id: id + idOffset, text, ...extra }, update_id: id + idOffset }),
        headers: { "x-test-secret": "history-secret" },
        method: "POST",
      }), "telegram", routeOptions)
      expect(response.status).toBe(200)
    },
    state: libsql,
  }
}

const adminContext = (overrides: Partial<OperationContext> = {}): OperationContext => ({
  access: { mode: "open", sections: "all" },
  request: new Request("http://vitehub.local/_vitehub/rpc/__call"),
  surface: "console",
  user: null,
  ...overrides,
})

function operation(name: string, overrides: Partial<OperationContext> = {}) {
  const found = agentChannelOperations.find(candidate => candidate.name === name)
  if (!found) throw new Error(`No operation ${name}`)
  return async (input: unknown) => {
    // SAFETY: Each test reads fields of the result that the operation documents.
    return await (found.run as (input: unknown, context: OperationContext) => Promise<any>)(await parseOperationInput(found, input), adminContext(overrides))
  }
}

const conversation = (thread = "telegram:456", overrides: Partial<OperationContext> = {}) => operation("channels.conversation", overrides)({ agent: "support", channel: "telegram", thread })
const lines = (messages: Array<{ role: string, text: string }>) => messages.map(message => `${message.role}: ${message.text}`)

describe("Channel conversation operations", () => {
  it("belongs to the channels section, with a name per surface", () => {
    expect(agentChannelOperations.map(candidate => [candidate.name, candidate.section, candidate.kind])).toEqual([
      ["channels.list", "channels", "read"],
      ["channels.threads", "channels", "read"],
      ["channels.conversation", "channels", "read"],
      ["conversations.export", "channels", "read"],
    ])
  })

  it("lists the Channels with the provider and whether ViteHub keeps their transcripts", async () => {
    await fixture({ state: "memory" })
    await expect(operation("channels.list")({})).resolves.toMatchObject({
      channels: [{ agent: "support", channel: "telegram", conversations: true, provider: "telegram", retention: { durable: false, maxMessages: 100, mode: "provider-window", transcripts: false, warning: expect.stringContaining("100 messages for 7 days") } }],
    })
    await fixture({ transcripts: false })
    await expect(operation("channels.list")({})).resolves.toMatchObject({ channels: [{ retention: { durable: false, mode: "provider-window", transcripts: false } }] })
    // A durable State keeps them without any option.
    await fixture()
    await expect(operation("channels.list")({})).resolves.toMatchObject({ channels: [{ retention: { durable: true, mode: "durable-transcripts", transcripts: true } }] })
  })

  it("lists the threads from the journal, with a cursor that survives new threads", async () => {
    const chat = await fixture()
    await chat.say(1, "hello")
    await chat.say(3, "other chat", {}, 789)
    const threads = await operation("channels.threads")({ agent: "support", channel: "telegram" })
    expect(threads.threads.map((thread: { thread: string }) => thread.thread).sort()).toEqual(["telegram:456", "telegram:789"])
    expect(threads.threads[0]).toMatchObject({ invocationCount: 1, participants: ["Maxi"] })
    // The list reads no conversation, so it has no message count.
    expect(threads.threads[0]).not.toHaveProperty("messageCount")
    const first = await operation("channels.threads")({ agent: "support", channel: "telegram", limit: 1 })
    expect(first.threads).toHaveLength(1)
    expect(first.nextCursor).toMatch(/^[\w-]+$/)
    // A thread that starts between two pages is not a repeat and does not shift the next page.
    await chat.say(5, "new chat", {}, 1000)
    const second = await operation("channels.threads")({ agent: "support", channel: "telegram", cursor: first.nextCursor, limit: 1 })
    expect(second.threads).toHaveLength(1)
    expect(second.threads[0].thread).not.toBe(first.threads[0].thread)
    const all = await operation("channels.threads")({ agent: "support", channel: "telegram" })
    expect(all.threads.map((thread: { thread: string }) => thread.thread)).toContain(second.threads[0].thread)
    await expect(operation("channels.threads")({ agent: "support", channel: "telegram", cursor: "nope" })).rejects.toMatchObject({ code: "CHANNELS_CURSOR_INVALID", status: 400 })
  })

  it("saves every message to the transcripts, so a conversation outlives the provider window", async () => {
    // The provider returns only the newest two messages and keeps no cache.
    const chat = await fixture({ cache: false, window: 2 })
    await chat.say(1, "first question")
    await chat.say(3, "second question")
    await chat.say(5, "third question")
    const read = await conversation()
    expect(read.retention).toMatchObject({ durable: true, mode: "durable-transcripts" })
    expect(lines(read.messages)).toEqual([
      "user: first question",
      "assistant: reply 1",
      "user: second question",
      "assistant: reply 2",
      "user: third question",
      "assistant: reply 3",
    ])
    expect(new Set(read.messages.map((message: { id: string }) => message.id)).size).toBe(read.messages.length)
    for (const message of read.messages) expect(message.invocationId, message.text).toEqual(expect.any(String))
    expect(read.messages[1].invocationId).toBe(read.messages[0].invocationId)
    expect(read.messages[1].invocationId).not.toBe(read.messages[3].invocationId)
    expect(read.messages.map((message: { source: string }) => message.source)).toContain("transcript")
    // The oldest messages come from the transcript, which keeps no names. The newest come from the provider.
    expect(read.messages[0].author).toMatchObject({ id: "456" })
    expect(read.messages[4].author).toMatchObject({ name: "Maxi" })
    const times = read.messages.map((message: { at: string }) => message.at)
    expect([...times].sort()).toEqual(times)
  })

  it("keeps no transcripts when the Channel turns them off, or when the State is not durable", async () => {
    for (const options of [{ cache: false, transcripts: false as const, window: 0 }, { cache: false, state: "memory" as const, window: 0 }]) {
      const chat = await fixture(options)
      await chat.say(1, "question")
      const read = await conversation()
      expect(read.retention).toMatchObject({ durable: false, transcripts: false, warning: expect.stringContaining("Transcripts are not durable") })
      expect(read.messages).toEqual([])
    }
  })

  it("reads transcripts through a Durable Object State", async () => {
    const chat = await fixture({ cache: false, state: "cloudflare", window: 1 })
    await chat.say(1, "first question")
    await chat.say(3, "second question")
    await expect(operation("channels.list")({})).resolves.toMatchObject({ channels: [{ retention: { durable: true, mode: "durable-transcripts" } }] })
    const read = await conversation()
    expect(lines(read.messages)).toEqual(["user: first question", "assistant: reply 1", "user: second question", "assistant: reply 2"])
  })

  it("keeps an answer that only an Invocation remembers", async () => {
    // No transcripts and a provider that returns nothing: the journal is the only record, because it keeps content.
    const chat = await fixture({ cache: false, content: true, transcripts: false, window: 0 })
    await chat.say(1, "question")
    const read = await conversation()
    expect(read.messages.map((message: { role: string, source: string, text: string }) => `${message.role}/${message.source}: ${message.text}`)).toEqual([
      "user/invocation: question",
      "assistant/invocation: reply 1",
    ])
    expect(read.messages[0].invocationId).toBe(read.messages[1].invocationId)
    const again = await fixture({ content: true })
    await again.say(1, "question")
    const full = await conversation()
    expect(full.messages.map((message: { source: string }) => message.source)).toEqual(["provider", "provider"])
  })

  it("pages a conversation with a cursor that survives new messages", async () => {
    const chat = await fixture()
    for (let id = 1; id <= 5; id += 2) await chat.say(id, `question ${id}`)
    const first = await operation("channels.conversation")({ agent: "support", channel: "telegram", limit: 4, thread: "telegram:456" })
    expect(first.messages).toHaveLength(4)
    expect(first.messageCount).toBe(6)
    await chat.say(7, "question 7")
    const second = await operation("channels.conversation")({ agent: "support", channel: "telegram", cursor: first.nextCursor, limit: 10, thread: "telegram:456" })
    expect(lines(second.messages)).toEqual(["user: question 5", "assistant: reply 3", "user: question 7", "assistant: reply 4"])
    expect(second.nextCursor).toBeUndefined()
    await expect(operation("channels.conversation")({ agent: "support", channel: "telegram", cursor: "nope", thread: "telegram:456" })).rejects.toMatchObject({ code: "CHANNELS_CURSOR_INVALID" })
  })

  it("fails with a coded error for an unknown Agent or Channel", async () => {
    await fixture()
    await expect(conversation("t", {})).rejects.toMatchObject({ code: "CHANNELS_THREAD_UNKNOWN" })
    await expect(operation("channels.conversation")({ agent: "ghost", channel: "telegram", thread: "t" })).rejects.toMatchObject({ code: "CHANNELS_NOT_FOUND", status: 404 })
    await expect(operation("channels.conversation")({ agent: "support", channel: "ghost", thread: "t" })).rejects.toMatchObject({ code: "CHANNELS_NOT_FOUND", status: 404 })
  })
})

describe("conversation privacy", () => {
  it("refuses a thread that the Channel does not know, before it asks the provider", async () => {
    const chat = await fixture()
    await chat.say(1, "hello")
    chat.adapter.fetchMessages.mockClear()
    await expect(conversation("telegram:999")).rejects.toMatchObject({ code: "CHANNELS_THREAD_UNKNOWN", status: 404 })
    await expect(operation("conversations.export")({ agent: "support", channel: "telegram", format: "json", thread: "telegram:999" })).rejects.toMatchObject({ code: "CHANNELS_THREAD_UNKNOWN" })
    expect(chat.adapter.fetchMessages).not.toHaveBeenCalled()
    // A thread with a transcript is known, even when the journal lost its Invocations.
    await expect(conversation("telegram:456")).resolves.toMatchObject({ messageCount: 2 })
  })

  it("lets an Agent read conversations only when its capability allows it", async () => {
    const chat = await fixture()
    await chat.say(1, "hello")
    const actor = { id: "telegram:456", kind: "chat" }
    const agentSurface = (overrides: Partial<OperationContext> = {}): Partial<OperationContext> => ({ actor, surface: "agent", user: null, ...overrides })
    // Unset: refused, on every operation that shows a conversation.
    await expect(conversation("telegram:456", agentSurface())).rejects.toMatchObject({ code: "CHANNELS_FORBIDDEN", status: 403 })
    await expect(operation("channels.threads", agentSurface())({ agent: "support", channel: "telegram" })).rejects.toMatchObject({ code: "CHANNELS_FORBIDDEN" })
    await expect(operation("conversations.export", agentSurface())({ agent: "support", channel: "telegram", thread: "telegram:456" })).rejects.toMatchObject({ code: "CHANNELS_FORBIDDEN" })
    // Participant: the Actor is the person of this thread.
    await expect(conversation("telegram:456", agentSurface({ conversations: "participant" }))).resolves.toMatchObject({ messageCount: 2 })
    // The Auth user of the Actor matches the same way.
    await expect(conversation("telegram:456", agentSurface({ actor: { id: "agent-1", meta: { authUserId: "456" } }, conversations: "participant" }))).resolves.toMatchObject({ messageCount: 2 })
    // Another person's thread, an Actor without an identity, and an unknown id are refused.
    await chat.say(3, "other", {}, 789)
    await expect(conversation("telegram:789", agentSurface({ conversations: "participant" }))).rejects.toMatchObject({ code: "CHANNELS_FORBIDDEN", message: expect.stringContaining("not a participant") })
    await expect(conversation("telegram:456", { conversations: "participant", surface: "agent", user: null })).rejects.toMatchObject({ code: "CHANNELS_FORBIDDEN", message: expect.stringContaining("no identity") })
    // The thread list shows an Actor only its own threads.
    const own = await operation("channels.threads", agentSurface({ conversations: "participant" }))({ agent: "support", channel: "telegram" })
    expect(own.threads.map((thread: { thread: string }) => thread.thread)).toEqual(["telegram:456"])
    const everything = await operation("channels.threads", agentSurface({ conversations: "all" }))({ agent: "support", channel: "telegram" })
    expect(everything.threads).toHaveLength(2)
    await expect(conversation("telegram:789", agentSurface({ conversations: "all" }))).resolves.toMatchObject({ messageCount: 2 })
  })

  it("never gives an Agent the media of an export", async () => {
    const chat = await fixture()
    await chat.say(1, "photo", { photo: [{ file_id: "photo-1", file_name: "meal.jpg", file_size: 3 }] })
    const asAgent = operation("conversations.export", { actor: { id: "telegram:456" }, conversations: "participant", surface: "agent", user: null })
    const exported = await asAgent({ agent: "support", channel: "telegram", format: "json", media: true, thread: "telegram:456" })
    expect(exported.media).toEqual([])
    expect(JSON.parse(exported.text).messages[0].attachments[0]).toMatchObject({ name: "meal.jpg", unavailable: true })
  })
})

describe("conversations.export", () => {
  it("exports Markdown with author and time headers, and attachment links", async () => {
    const chat = await fixture({ state: "memory" })
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

  it("cannot be turned into other Markdown by a message, a name, or an attachment", async () => {
    const chat = await fixture({ state: "memory" })
    const text = "```\n# fake heading\n````\n[click](javascript:alert(1))\n<script>alert(1)</script>"
    await chat.say(1, text, { document: { file_name: "evil](https://evil.example).pdf", file_size: 3, mime_type: "application/pdf", url: "javascript:alert(1)" } })
    const exported = await operation("conversations.export")({ agent: "support", channel: "telegram", format: "markdown", thread: "telegram:456" })
    // The text sits in a fence of five backticks, since the text holds a run of four.
    expect(exported.text).toContain(`\`\`\`\`\`text\n${text}\n\`\`\`\`\``)
    const outsideTheFence = exported.text.replace(`\`\`\`\`\`text\n${text}\n\`\`\`\`\``, "")
    expect(outsideTheFence.split("\n").filter((line: string) => line.startsWith("#"))).toEqual(["# Conversation telegram:456", "### Maxi · 2026-06-10 12:01:00 UTC", "### Agent · 2026-06-10 12:01:01 UTC"])
    // The name is escaped, and a javascript: URL is not a link.
    expect(exported.text).toContain("- Attachment: evil\\]\\(https://evil.example\\).pdf (not included)")
    expect(outsideTheFence).not.toContain("javascript:")
  })

  it("exports the JSON archive of schema version 1 with files in place of data", async () => {
    const chat = await fixture()
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

  it("says so when the transcript limit cut the oldest messages", async () => {
    const chat = await fixture({ cache: false, window: 0 })
    await chat.say(1, "hello")
    await chat.state.connect()
    for (let index = 0; index < 500; index++) {
      await chat.state.appendToList("chat:support:transcripts:user:telegram:456", { id: `old-${index}`, platformMessageId: `old-${index}`, role: "user", text: `old ${index}`, threadId: "telegram:456", timestamp: 1_700_000_000_000 + index, userKey: "telegram:456" })
    }
    const read = await conversation()
    expect(read.truncated).toBe(true)
    const json = await operation("conversations.export")({ agent: "support", channel: "telegram", format: "json", thread: "telegram:456" })
    expect(json.truncated).toBe(true)
    expect(JSON.parse(json.text).truncated).toBe(true)
    const markdown = await operation("conversations.export")({ agent: "support", channel: "telegram", format: "markdown", thread: "telegram:456" })
    expect(markdown.text).toContain("Warning: the transcript was cut at its read limit")
  })

  it("serves the same archive from the signed channels history route, and never fails on the journal", async () => {
    const chat = await fixture({ journalFails: true, state: "memory" })
    await chat.say(1, "hello", { photo: [{ file_id: "photo-1", file_name: "meal.jpg", file_size: 3 }] })
    const response = await chat.history("telegram:456")
    expect(response.status).toBe(200)
    // SAFETY: The route answers with the archive that the test reads below.
    const signed = await response.json() as Record<string, any>
    // `channels history` keeps the attachment data in the answer, and the CLI moves it into files.
    expect(signed.messages[0].attachments[0]).toMatchObject({ data: photo.toString("base64"), name: "meal.jpg" })
    expect(signed).toMatchObject({ agent: "support", channel: "telegram", provider: "telegram", schemaVersion: 1, threadId: "telegram:456" })
    // The signed route reads a thread that the journal does not know: the secret is the proof.
    const other = await chat.history("telegram:123456")
    expect(other.status).toBe(200)
  })
})

describe("operation failures", () => {
  it("name their cause and their fix", async () => {
    const { ChannelAdapterUnavailableError, ChannelArchiveTooLargeError, ChannelStateUnavailableError } = await import("../src/channels-console-host.ts")
    const fail = (error: Error) => installChannelsConsoleHost({
      agents: { support: {} as never },
      handlers: { support: { channels: async () => [], conversation: async () => { throw error }, threads: async () => [] } as never },
      options: () => ({}),
    })
    fail(new ChannelArchiveTooLargeError("Channel history archive exceeds the 35 MiB response limit."))
    await expect(conversation()).rejects.toMatchObject({ code: "CHANNELS_EXPORT_TOO_LARGE", status: 413 })
    fail(new ChannelAdapterUnavailableError("no adapter"))
    await expect(conversation()).rejects.toMatchObject({ code: "CHANNELS_ADAPTER_MISSING", status: 500 })
    fail(new ChannelStateUnavailableError("The Agent State could not be read: down"))
    await expect(conversation()).rejects.toMatchObject({ code: "CHANNELS_HOST_UNAVAILABLE", status: 503, fix: expect.stringContaining("VITEHUB_AGENT_STATE_URL") })
    fail(new Error("provider exploded"))
    await expect(conversation()).rejects.toMatchObject({ code: "CHANNELS_PROVIDER_FAILED", status: 502 })
  })

  it("answers CHANNELS_HOST_UNAVAILABLE, naming the State options, until the webhook routes have started", async () => {
    Reflect.deleteProperty(globalThis, Symbol.for("vitehub.agent.channels-console"))
    await expect(operation("channels.list")({})).rejects.toMatchObject({ code: "CHANNELS_HOST_UNAVAILABLE", fix: expect.stringContaining("Durable Object") })
  })
})
