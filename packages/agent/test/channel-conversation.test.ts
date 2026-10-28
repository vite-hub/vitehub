import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Chat, Message } from "chat"
import { afterEach, describe, expect, it, vi } from "vitest"

import { installChannelsConsoleHost } from "../src/channels-console-host.ts"
import { access } from "../src/capabilities/access.ts"
import { defineChatCapability } from "../src/chat-trigger.ts"
import { defineAgent } from "../src/index.ts"
import { channelConversationArchive } from "../src/internal/channel-conversation.ts"
import { interruptedChatRetrySuffix } from "../src/internal/chat-reply.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import { agentChannelOperations } from "../src/operations.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createCloudflareAgentState } from "../src/state/providers/cloudflare.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"
import { createFakeCloudflareStateNamespace } from "./support/cloudflare-state-namespace.ts"

import { parseOperationInput } from "@vite-hub/internal/operations"

import type { AgentCapabilityDefinition, AgentChatOptions } from "../src/types.ts"
import type { OperationContext } from "@vite-hub/internal/operations"
import type { Adapter, ChatInstance, StateAdapter, WebhookOptions } from "chat"

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }))

const webhookUrl = "https://example.com/api/_vitehub/agents/support/webhooks/telegram"

// Every message runs the chat route with a libSQL State, which takes a moment.
vi.setConfig({ testTimeout: 30_000 })
const photo = Buffer.from([1, 2, 3])

interface TelegramMessage {
  chat: { id: number, type: "private" | "supergroup" }
  date: number
  document?: { file_name: string, file_size: number, mime_type: string, url: string }
  from: { id: number, username: string }
  message_id: number
  photo?: { file_id: string, file_name: string, file_size: number }[]
  text: string
}

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
      const body = await request.json() as { message?: TelegramMessage }
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
        isMention: raw.chat.type === "supergroup",
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
    isDM: vi.fn((threadId: string) => Number(threadId.split(":")[1]) > 0),
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
  return Object.assign(adapter, {
    deleteHistory: async (userKey: string) => {
      if (!chat) throw new Error("Chat is not initialized")
      return await chat.history.user.delete({ userKey })
    },
    messages,
  })
}


interface Fixture {
  adapter: ReturnType<typeof telegramAdapter>
  invocationStore: ReturnType<typeof createMemoryAgentInvocationStore>
  /** The route handler that the generated webhook route calls, asked for the signed history. */
  history: (threadId: string) => Promise<Response>
  state: StateAdapter
  recover: (placeholder?: "edit" | "failed-edit", legacy?: boolean, retryFailure?: boolean) => Promise<void>
  say: (id: number, text: string, extra?: Partial<TelegramMessage>, chat?: number) => Promise<void>
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
  channel?: string
  cache?: boolean
  content?: boolean
  rejection?: "access" | "filter"
  identity?: AgentChatOptions["identity"]
  secretToken?: false
  /** `libsql` (the default) and `cloudflare` are durable. `memory` uses the in-process State of the route. */
  state?: "cloudflare" | "libsql" | "memory"
  /** Sets `channels.telegram.transcripts`. */
  transcripts?: false | { maxPerUser?: number, retention?: number }
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
  const invocationStore = createMemoryAgentInvocationStore()
  const invocations = defineAgentInvocations({ ...(options.content ? { content: "content" as const } : {}), store: invocationStore })
  const channel = options.channel ?? "telegram"
  const capabilities: AgentCapabilityDefinition[] = [
    defineChatCapability({
      // SAFETY: The fake implements the Adapter methods that the chat route calls.
      platforms: { telegram: () => adapter as unknown as Adapter },
      stream: false,
      ...(options.rejection === "filter" ? { filter: () => false } : {}),
      ...(options.identity ? { identity: options.identity } : {}),
      ...(options.transcripts !== undefined ? { transcripts: options.transcripts } : {}),
      webhooks: { [channel]: { adapter: "telegram", secretHeader: "x-test-secret", secretToken: options.secretToken ?? "history-secret" } },
    }),
  ]
  if (options.rejection === "access") capabilities.push(access({ chat: { resolve: () => false } }))
  const agent = defineAgent({
    capabilities,
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
    invocationStore,
    async recover(placeholder, legacy = false, retryFailure = false) {
      const message = adapter.messages.find(message => !message.author.isBot)!
      const key = `chat:support:${channel}:vitehub:interrupted-chat`
      await state!.set(key, {
        interrupted: {
          agentName: "support", runId: "interrupted", threadId: message.threadId,
          message: { ...message.toJSON(), id: retryFailure ? message.id : `${message.id}${interruptedChatRetrySuffix}` },
          startedAt: new Date(Date.now() - 1_000).toISOString(),
          ...(legacy ? {} : { transcriptUserKey: message.userKey ?? null }),
          ...(placeholder ? { placeholderId: "restart-placeholder" } : {}),
        },
      })
      if (placeholder === "failed-edit") adapter.editMessage.mockRejectedValueOnce(new Error("placeholder deleted"))
      if (retryFailure) {
        const failure = new Error("retry dispatch failed")
        const dispatch = vi.spyOn(Chat.prototype, "processMessage").mockRejectedValueOnce(failure)
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
        const stop = handler.resume({ ...routeOptions, webhookState: state, recoverInterruptedBefore: Date.now() })
        try {
          await vi.waitFor(() => expect(consoleError.mock.calls.some(call => call.includes(failure))).toBe(true))
          await stop()
          await vi.waitFor(async () => {
            const saved = await state!.get<Record<string, { recoveryToken?: string }>>(key)
            expect(saved?.interrupted).toBeDefined()
            expect(saved?.interrupted).not.toHaveProperty("recoveryToken")
          })
        }
        finally {
          await stop()
          dispatch.mockRestore()
          consoleError.mockRestore()
        }
      }
      const stop = handler.resume({ ...routeOptions, webhookState: state, recoverInterruptedBefore: Date.now() })
      try {
        await vi.waitFor(async () => expect(await state!.get(key)).toBeNull(), { timeout: 5_000 })
      }
      finally {
        await stop()
      }
    },
    history: threadId => {
      if (options.journalFails) invocations.list = async () => { throw new Error("journal down") }
      return handler(new Request(webhookUrl, {
        body: JSON.stringify({ threadId }),
        headers: { "content-type": "application/json", "x-test-secret": "history-secret", "x-vitehub-channel-history": "1" },
        method: "POST",
      }), channel, routeOptions)
    },
    async say(id, text, extra = {}, chat = 456) {
      vi.setSystemTime(new Date(Date.parse("2026-06-10T12:00:00.000Z") + id * 60_000))
      const message: TelegramMessage = { chat: { id: chat, type: "private" }, date: Math.floor(Date.now() / 1000), from: { id: chat, username: "maxi" }, message_id: id + idOffset, text, ...extra }
      const response = await handler(new Request(webhookUrl, {
        body: JSON.stringify({ message, update_id: id + idOffset }),
        headers: { "x-test-secret": "history-secret" },
        method: "POST",
      }), channel, routeOptions)
      expect(response.status).toBe(200)
    },
    state: state ?? libsql,
  }
}

const adminContext = (overrides: Partial<OperationContext> = {}): OperationContext => ({
  access: { mode: "open", sections: "all" },
  request: new Request("http://vitehub.local/_vitehub/rpc/__call"),
  surface: "console",
  user: null,
  ...overrides,
})

const operations = {
  "channels.list": agentChannelOperations[0],
  "channels.threads": agentChannelOperations[1],
  "channels.conversation": agentChannelOperations[2],
  "conversations.export": agentChannelOperations[3],
}
type Operations = typeof operations
type OperationInput<Name extends keyof Operations> = Parameters<Operations[Name]["run"]>[0]
// The export schema supplies format and media defaults, so callers may omit them.
type OperationRequest<Name extends keyof Operations> = Omit<OperationInput<Name>, "format" | "media"> & Partial<Pick<OperationInput<Name>, Extract<keyof OperationInput<Name>, "format" | "media">>>

function operation<Name extends keyof Operations>(name: Name, overrides: Partial<OperationContext> = {}) {
  const found = operations[name]
  return async (input: OperationRequest<Name>): Promise<Awaited<ReturnType<Operations[Name]["run"]>>> => {
    const parsed = await parseOperationInput(found, input)
    // SAFETY: The matching operation schema validates input; the named operation owns its result type.
    return await found.run(parsed as never, adminContext(overrides)) as Awaited<ReturnType<Operations[Name]["run"]>>
  }
}

// SAFETY: The operation and signed history route return this archive; tests assert its fields below.
const parseArchive = (text: string) => JSON.parse(text) as ReturnType<typeof channelConversationArchive>

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
    expect(threads.threads.map(thread => thread.thread).sort()).toEqual(["telegram:456", "telegram:789"])
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
    expect(all.threads.map(thread => thread.thread)).toContain(second.threads[0].thread)
    await expect(operation("channels.threads")({ agent: "support", channel: "telegram", cursor: "nope" })).rejects.toMatchObject({ code: "CHANNELS_CURSOR_INVALID", status: 400 })
  })

  it("reads journal threads using the Channel id when its adapter key differs", async () => {
    const chat = await fixture({ channel: "support-telegram", transcripts: false })
    await chat.say(1, "hello")
    const input = { agent: "support", channel: "support-telegram" }
    await expect(operation("channels.threads")(input)).resolves.toMatchObject({ threads: [{ thread: "telegram:456" }] })
    await expect(operation("channels.conversation")({ ...input, thread: "telegram:456" })).resolves.toMatchObject({ messageCount: 2 })
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
    expect(new Set(read.messages.map(message => message.id)).size).toBe(read.messages.length)
    for (const message of read.messages) expect(message.invocationId, message.text).toEqual(expect.any(String))
    expect(read.messages[1].invocationId).toBe(read.messages[0].invocationId)
    expect(read.messages[1].invocationId).not.toBe(read.messages[3].invocationId)
    expect(read.messages.map(message => message.source)).toContain("transcript")
    // The oldest messages come from the transcript, which keeps no names. The newest come from the provider.
    expect(read.messages[0].author).toMatchObject({ id: "456" })
    expect(read.messages[4].author).toMatchObject({ name: "Maxi" })
    const times = read.messages.map(message => message.at)
    expect([...times].sort()).toEqual(times)
  })

  it.each([undefined, "edit", "failed-edit"] as const)("retains restart notices after provider history expires (%s)", async (delivery) => {
    const chat = await fixture({ cache: false, window: 0, identity: ({ author }) => `account:${author.userId}` })
    await chat.say(1, "hello")
    await chat.recover(delivery)
    const result = await conversation()
    expect(result.messages.filter(message => message.text.includes("The server restarted twice"))).toHaveLength(1)
    expect(result.messages.filter(message => message.text === "hello")).toHaveLength(1)
    const exported = await operation("conversations.export")({ agent: "support", channel: "telegram", thread: "telegram:456", format: "json" })
    expect(exported.text).toContain("The server restarted twice")
  })

  it.each([undefined, "edit", "failed-edit"] as const)("does not repeat a restart notice after retry dispatch fails (%s)", async (delivery) => {
    const chat = await fixture({ cache: false, window: 0, identity: ({ author }) => `account:${author.userId}`, secretToken: false })
    await chat.say(1, "hello")
    await chat.recover(delivery, false, true)
    const notice = "The server restarted while I was working on this. I'll retry it automatically."
    const posts = chat.adapter.postMessage.mock.calls.filter(([, text]) => String(text).includes(notice))
    const edits = chat.adapter.editMessage.mock.calls.filter(([, , text]) => String(text).includes(notice))
    expect(posts).toHaveLength(delivery === "edit" ? 0 : 1)
    expect(edits).toHaveLength(delivery ? 1 : 0)
    const result = await conversation()
    expect(result.messages.filter(message => message.text.includes(notice))).toHaveLength(1)
    expect(result.messages.some(message => message.text === "reply 2")).toBe(true)
    const exported = await operation("conversations.export")({ agent: "support", channel: "telegram", thread: "telegram:456", format: "json" })
    expect(parseArchive(exported.text).messages.filter(message => message.text.includes(notice))).toHaveLength(1)
  })

  it("recovers transcript identity for restart records from before identity was persisted", async () => {
    const chat = await fixture({ cache: false, window: 0, identity: ({ author }) => `account:${author.userId}` })
    await chat.say(1, "hello")
    await chat.recover(undefined, true)
    expect((await conversation()).messages.some(message => message.text.includes("The server restarted twice"))).toBe(true)
  })

  it.each(["account:456", null])("preserves the saved identity when the resolver changes (%s)", async (originalKey) => {
    let identity = originalKey
    const chat = await fixture({ cache: false, window: 0, identity: () => identity })
    await chat.say(1, "hello")
    identity = "account:other"
    await chat.recover()
    expect(await chat.state.getList("chat:support:transcripts:user:account:other")).toEqual([])
    const retained = (await conversation()).messages.some(message => message.text.includes("The server restarted twice"))
    expect(retained).toBe(originalKey !== null)
    expect(chat.adapter.postMessage.mock.calls.some(([, text]) => String(text).includes("The server restarted twice"))).toBe(true)
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
    expect(read.messages.map(message => `${message.role}/${message.source}: ${message.text}`)).toEqual([
      "user/invocation: question",
      "assistant/invocation: reply 1",
    ])
    expect(read.messages[0].invocationId).toBe(read.messages[1].invocationId)
    const again = await fixture({ content: true })
    await again.say(1, "question")
    const full = await conversation()
    expect(full.messages.map(message => message.source)).toEqual(["provider", "provider"])
  })

  it("retains delivered journal replies when the Invocation later fails", async () => {
    const chat = await fixture({ cache: false, content: true, transcripts: false, window: 0 })
    const timestamp = new Date().toISOString()
    await chat.invocationStore.create({
      id: "failed-with-replies", agentName: "support", origin: "telegram", threadId: "telegram:456",
      status: "failed", traceId: "failed-with-replies", createdAt: timestamp, updatedAt: timestamp,
      observations: [
        { name: "agent.invocation.start", type: "run", sequence: 1, timestamp, attributes: { "input.messages": [{ role: "user", parts: [{ type: "text", text: "question" }] }] } },
        { name: "agent.channel.delivery.effect", type: "lifecycle", sequence: 2, timestamp, attributes: { "channel.effect.kind": "reply", "channel.effect.content": "delivered reply" } },
        { name: "agent.invocation.finish", type: "run", sequence: 3, timestamp, attributes: { "result.text": "undelivered final text" } },
      ],
    })
    expect(lines((await conversation()).messages)).toEqual(["user: question", "assistant: delivered reply"])
    const exported = await operation("conversations.export")({ agent: "support", channel: "telegram", thread: "telegram:456", format: "json" })
    expect(parseArchive(exported.text).messages.map(message => message.text)).toEqual(["question", "delivered reply"])
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

  it("keeps equal-time messages after the cursor message leaves the provider window", async () => {
    const chat = await fixture({ cache: false, transcripts: false })
    await chat.say(1, "first question")
    await chat.say(3, "second question")
    const time = chat.adapter.messages[0].metadata.dateSent
    for (const message of chat.adapter.messages) message.metadata.dateSent = time
    const first = await operation("channels.conversation")({ agent: "support", channel: "telegram", limit: 1, thread: "telegram:456" })
    expect(first.messages.map(message => message.id)).toEqual(["1"])
    chat.adapter.messages.splice(0, 1)
    const second = await operation("channels.conversation")({ agent: "support", channel: "telegram", cursor: first.nextCursor, thread: "telegram:456" })
    expect(second.messages.map(message => message.id)).toEqual(["3", "sent-1", "sent-2"])
  })

  it("fails with a coded error for an unknown Agent or Channel", async () => {
    await fixture()
    await expect(conversation("t", {})).rejects.toMatchObject({ code: "CHANNELS_THREAD_UNKNOWN" })
    await expect(operation("channels.conversation")({ agent: "ghost", channel: "telegram", thread: "t" })).rejects.toMatchObject({ code: "CHANNELS_NOT_FOUND", status: 404 })
    await expect(operation("channels.conversation")({ agent: "support", channel: "ghost", thread: "t" })).rejects.toMatchObject({ code: "CHANNELS_NOT_FOUND", status: 404 })
  })
})

describe("conversation privacy", () => {
  it.each(["access", "filter"] as const)("refuses a group whose only message was rejected by %s before asking the provider", async (rejection) => {
    const chat = await fixture({ rejection })
    await chat.say(1, "rejected message", { chat: { id: -100, type: "supergroup" } }, -100)
    const index = await chat.state.getList("chat:support:telegram:transcripts:thread:telegram:-100")
    expect(index).not.toHaveLength(0)
    chat.adapter.fetchMessages.mockClear()
    await expect(conversation("telegram:-100")).rejects.toMatchObject({ code: "CHANNELS_THREAD_UNKNOWN", status: 404 })
    await expect(operation("conversations.export")({ agent: "support", channel: "telegram", format: "json", thread: "telegram:-100" })).rejects.toMatchObject({ code: "CHANNELS_THREAD_UNKNOWN" })
    expect(chat.adapter.fetchMessages).not.toHaveBeenCalled()
  })

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
    expect(own.threads.map(thread => thread.thread)).toEqual(["telegram:456"])
    const everything = await operation("channels.threads", agentSurface({ conversations: "all" }))({ agent: "support", channel: "telegram" })
    expect(everything.threads).toHaveLength(2)
    await expect(conversation("telegram:789", agentSurface({ conversations: "all" }))).resolves.toMatchObject({ messageCount: 2 })
  })

  it("preserves custom transcript identity namespaces in participant authorization", async () => {
    const chat = await fixture({ cache: false, identity: () => "account:verified", window: 2 })
    await chat.say(1, "private question")
    await chat.say(3, "another private question")
    const participant = { conversations: "participant", surface: "agent", user: null } as const
    await expect(conversation("telegram:456", { ...participant, actor: { id: "verified" } })).rejects.toMatchObject({ code: "CHANNELS_FORBIDDEN", status: 403 })
    await expect(conversation("telegram:456", { ...participant, user: { id: "verified" } })).rejects.toMatchObject({ code: "CHANNELS_FORBIDDEN", status: 403 })
    await expect(conversation("telegram:456", { ...participant, actor: { id: "account:verified" } })).resolves.toMatchObject({ messageCount: 4 })
  })

  it.each(["deleted", "expired"] as const)("denies indexed participants whose transcripts were %s", async (removed) => {
    const chat = await fixture({ cache: false, journalFails: true, transcripts: removed === "expired" ? { retention: 60_000 } : { maxPerUser: 100 }, window: 2 })
    const group = { id: -100, type: "supergroup" } as const
    await chat.say(1, "former participant", { chat: group, from: { id: 456, username: "first" } }, group.id)
    if (removed === "deleted") expect((await chat.adapter.deleteHistory("telegram:456")).deleted).toBeGreaterThan(0)
    // The next message expires the first user's TTL in the retention case.
    await chat.say(3, "current participant", { chat: group, from: { id: 789, username: "second" } }, group.id)
    await chat.history("telegram:-100") // Make the journal unavailable, so retained transcript identities decide access.
    const participant = { conversations: "participant", surface: "agent", user: null } as const
    await expect(conversation("telegram:-100", { ...participant, actor: { id: "telegram:456" } })).rejects.toMatchObject({ code: "CHANNELS_FORBIDDEN", status: 403 })
    await expect(conversation("telegram:-100", { ...participant, actor: { id: "telegram:789" } })).resolves.toMatchObject({ messageCount: 2 })
  })

  it.each(["libsql", "cloudflare"] as const)("recovers all group participants from %s after provider history and the thread cache expire", async (state) => {
    // The default Invocation journal retains metadata, not message content.
    const chat = await fixture({ journalFails: true, state, window: 1 })
    const group = { id: -100, type: "supergroup" } as const
    await chat.say(1, "first participant", { chat: group, from: { id: 456, username: "first" } }, group.id)
    await chat.say(3, "second participant", { chat: group, from: { id: 789, username: "second" } }, group.id)
    const expected = ["user: first participant", "assistant: reply 1", "user: second participant", "assistant: reply 2"]
    const partial = await conversation("telegram:-100")
    // Only durable transcripts can supply the conversation after both windows expire.
    chat.adapter.fetchMessages.mockResolvedValue({ messages: [] })
    vi.setSystemTime(Date.now() + 8 * 86_400_000)
    // The fake Durable Object namespace has no TTL implementation; evict its expired cache explicitly.
    if (state === "cloudflare") await chat.state.delete("chat:support:telegram:msg-history:telegram:-100")
    const recovered = await conversation("telegram:-100")
    expect(recovered.retention.mode).toBe("durable-transcripts")
    expect(lines(recovered.messages)).toEqual(expected)
    expect(recovered.messages.every(message => message.source === "transcript")).toBe(true)
    expect(lines(partial.messages)).toEqual(expected)
    // The durable lookup also proves a group is known if the journal becomes unavailable.
    await chat.history("telegram:-100")
    expect(lines((await conversation("telegram:-100")).messages)).toEqual(expected)
  })

  it("finds group participants who are absent from a partial provider window", async () => {
    const chat = await fixture({ cache: false, window: 2 })
    const group = { id: -100, type: "supergroup" } as const
    await chat.say(1, "old participant", { chat: group, from: { id: 456, username: "first" } }, group.id)
    await chat.say(3, "recent participant", { chat: group, from: { id: 789, username: "second" } }, group.id)
    expect(lines((await conversation("telegram:-100")).messages)).toEqual(["user: old participant", "assistant: reply 1", "user: recent participant", "assistant: reply 2"])
  })

  it("keeps default Telegram direct-message access with only durable transcripts", async () => {
    const chat = await fixture({ cache: false, journalFails: true, window: 0 })
    await chat.say(1, "hello")
    await chat.history("telegram:456") // Make the journal unavailable, leaving transcripts as the only source.
    const participant = { conversations: "participant", surface: "agent", user: null } as const
    await expect(conversation("telegram:456", { ...participant, actor: { id: "telegram:456" } })).resolves.toMatchObject({ messageCount: 2 })
    await expect(conversation("telegram:456", { ...participant, actor: { id: "agent", meta: { authUserId: "456" } } })).resolves.toMatchObject({ messageCount: 2 })
  })

  it("never gives an Agent the media of an export", async () => {
    const chat = await fixture()
    await chat.say(1, "photo", { photo: [{ file_id: "photo-1", file_name: "meal.jpg", file_size: 3 }] })
    const asAgent = operation("conversations.export", { actor: { id: "telegram:456" }, conversations: "participant", surface: "agent", user: null })
    const exported = await asAgent({ agent: "support", channel: "telegram", format: "json", media: true, thread: "telegram:456" })
    expect(exported.media).toEqual([])
    expect(parseArchive(exported.text).messages[0].attachments[0]).toMatchObject({ name: "meal.jpg", unavailable: true })
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
    expect(outsideTheFence.split("\n").filter(line => line.startsWith("#"))).toEqual(["# Conversation telegram:456", "### Maxi · 2026-06-10 12:01:00 UTC", "### Agent · 2026-06-10 12:01:01 UTC"])
    // The name is escaped, and a javascript: URL is not a link.
    expect(exported.text).toContain("- Attachment: evil\\]\\(https://evil.example\\).pdf (not included)")
    expect(outsideTheFence).not.toContain("javascript:")
  })

  it("exports the JSON archive of schema version 1 with files in place of data", async () => {
    const chat = await fixture()
    await chat.say(1, "photo", { photo: [{ file_id: "photo-1", file_name: "meal.jpg", file_size: 3 }] })
    const exported = await operation("conversations.export")({ agent: "support", channel: "telegram", format: "json", media: true, thread: "telegram:456" })
    expect(exported).toMatchObject({ filename: "history.json", format: "json", mimeType: "application/json" })
    const archive = parseArchive(exported.text)
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
    expect(exported.media.map(file => file.path)).toEqual(["media/0001-meal.jpg"])
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
    expect(parseArchive(json.text).truncated).toBe(true)
    const markdown = await operation("conversations.export")({ agent: "support", channel: "telegram", format: "markdown", thread: "telegram:456" })
    expect(markdown.text).toContain("Warning: the transcript was cut at its read limit")
  })

  it("serves the same archive from the signed channels history route, and never fails on the journal", async () => {
    const chat = await fixture({ journalFails: true, state: "memory" })
    await chat.say(1, "hello", { photo: [{ file_id: "photo-1", file_name: "meal.jpg", file_size: 3 }] })
    const response = await chat.history("telegram:456")
    expect(response.status).toBe(200)
    // SAFETY: The route answers with the archive that the test reads below.
    const signed = parseArchive(await response.text())
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
