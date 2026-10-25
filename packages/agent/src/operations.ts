import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import {
  ChannelAdapterUnavailableError,
  ChannelArchiveTooLargeError,
  channelsConsoleHost,
  ChannelStateUnavailableError,
  ChannelThreadUnknownError,
  ChannelUnknownError,
} from "./channels-console-host.ts"
import {
  channelAuthorName,
  channelConversationArchive,
  channelMessageCursor,
  channelMessageTime,
  decodeChannelCursor,
  encodeChannelCursor,
  materializeChannelArchive,
  pageAfterChannelCursor,
  renderChannelConversationMarkdown,
} from "./internal/channel-conversation.ts"

import type { AnyOperation, OperationContext } from "@vite-hub/internal/operations"
import type { ChannelsConsoleHost } from "./channels-console-host.ts"
import type { ChannelArchiveMedia, ChannelConversationMessage, ChannelCursor } from "./internal/channel-conversation.ts"
import type { AgentChannelConversation, AgentChannelRetention } from "./server/routes.ts"

class ChannelsOperationError extends Error {
  readonly code: string
  readonly fix?: string
  readonly status: number

  constructor(status: number, code: string, message: string, fix?: string) {
    super(message)
    this.code = code
    this.status = status
    if (fix) this.fix = fix
  }
}

const maximumMediaBytes = 25 * 1024 * 1024
const maximumArchiveBytes = 35 * 1024 * 1024
const defaultThreads = 25
const maximumThreads = 100
const defaultMessages = 100
const maximumMessages = 500
const stateFix = "Give the Agent a State that can read lists: libSQL with `VITEHUB_AGENT_STATE_URL` or `agent.providers.state`, or a Cloudflare Durable Object State (`agent.providers.state: \"cloudflare\"`). The generated webhook route installs the reader when the server starts."

function host(): ChannelsConsoleHost {
  const installed = channelsConsoleHost()
  if (!installed) {
    throw new ChannelsOperationError(503, "CHANNELS_HOST_UNAVAILABLE", "The Channel webhook routes of this app have not started in this process, or the Agent State cannot read conversations.", stateFix)
  }
  return installed
}

function handlerOf(installed: ChannelsConsoleHost, agent: string) {
  const handler = installed.handlers[agent]
  if (!handler) throw new ChannelsOperationError(404, "CHANNELS_NOT_FOUND", `The app has no Agent named ${JSON.stringify(agent)} with Channels.`, "Run `vitehub channels list` to see the Agents and Channels.")
  return handler
}

function requestOf(context: OperationContext): Request {
  return context.request ?? new Request("http://vitehub.local/_vitehub/channels")
}

/** The failure of a read as a coded operation failure. */
function failureOf(error: unknown): Error {
  if (error instanceof ChannelsOperationError) return error
  if (error instanceof ChannelUnknownError) return new ChannelsOperationError(404, "CHANNELS_NOT_FOUND", error.message, "Run `vitehub channels list` to see the Channels that keep conversations.")
  if (error instanceof ChannelThreadUnknownError) return new ChannelsOperationError(404, "CHANNELS_THREAD_UNKNOWN", error.message, "Run `vitehub channels threads <agent> <channel>` to see the threads of the Channel.")
  if (error instanceof ChannelAdapterUnavailableError) return new ChannelsOperationError(500, "CHANNELS_ADAPTER_MISSING", error.message, "Configure the Chat adapter of the Channel, such as its bot token, so the provider history can be read.")
  if (error instanceof ChannelArchiveTooLargeError) return new ChannelsOperationError(413, "CHANNELS_EXPORT_TOO_LARGE", error.message, "Export without media, or read the conversation page by page with `channels conversation`.")
  if (error instanceof ChannelStateUnavailableError) return new ChannelsOperationError(503, "CHANNELS_HOST_UNAVAILABLE", error.message, stateFix)
  return new ChannelsOperationError(502, "CHANNELS_PROVIDER_FAILED", `The provider history could not be read: ${error instanceof Error ? error.message : String(error)}`)
}

/** The ids that tell whether the caller is a person of a thread: the user, the Actor, and the Auth user of the Actor. */
function callerIds(context: OperationContext): string[] {
  const meta: unknown = context.actor?.meta
  const authUserId = meta !== null && typeof meta === "object" ? Reflect.get(meta, "authUserId") : undefined
  return [context.user?.id, context.actor?.id, authUserId].filter((value): value is string => typeof value === "string" && value !== "")
}

/**
 * What the caller may read. A person on the Console, CLI, or MCP has the section. An Agent has only what
 * `operations({ conversations })` gave it: nothing when it is unset, the threads it takes part in with `participant`.
 */
function conversationAccess(context: OperationContext): "all" | "participant" {
  if (context.surface !== "agent") return "all"
  if (!context.conversations) {
    throw new ChannelsOperationError(403, "CHANNELS_FORBIDDEN", "An Agent can read Channel conversations only when its operations() capability sets `conversations`.", "Create the capability with `operations({ conversations: \"participant\" })` to let it read the threads it takes part in.")
  }
  return context.conversations
}

function assertParticipant(context: OperationContext, participants: readonly string[]): void {
  const ids = callerIds(context)
  if (ids.some(id => participants.includes(id))) return
  throw new ChannelsOperationError(
    403,
    "CHANNELS_FORBIDDEN",
    ids.length ? "The Actor is not a participant of this thread." : "The Actor has no identity that can be matched to the people of this thread.",
    "Read the thread the Agent is answering in, or create the capability with `conversations: \"all\"`.",
  )
}

async function readConversation(context: OperationContext, input: { agent: string, attachmentBytes?: number, channel: string, thread: string }): Promise<AgentChannelConversation> {
  const installed = host()
  const handler = handlerOf(installed, input.agent)
  const mode = conversationAccess(context)
  let conversation: AgentChannelConversation
  try {
    // An Agent never gets media, whatever the caller asked for.
    const attachmentBytes = context.surface === "agent" ? 0 : input.attachmentBytes ?? 0
    conversation = await handler.conversation(requestOf(context), { attachmentBytes, channel: input.channel, threadId: input.thread }, installed.options(input.agent, context.env))
  }
  catch (error) {
    throw failureOf(error)
  }
  if (context.surface === "agent" && mode === "participant") assertParticipant(context, conversation.participants)
  return conversation
}

/** How long a Channel keeps its history, as the operations report it. */
export interface ChannelRetentionView {
  durable: boolean
  maxMessages: number
  mode: "durable-transcripts" | "provider-window"
  transcripts: boolean
  ttlMs: number
  /** Present when older messages may be missing. */
  warning?: string
}

function retentionOf(retention: AgentChannelRetention): ChannelRetentionView {
  return {
    durable: retention.durable,
    maxMessages: retention.maxMessages,
    mode: retention.durable ? "durable-transcripts" : "provider-window",
    transcripts: retention.transcripts,
    ttlMs: retention.ttlMs,
    ...(retention.durable
      ? {}
      : { warning: `Transcripts are not durable. The provider keeps ${retention.maxMessages} messages for ${Math.max(1, Math.round(retention.ttlMs / 86_400_000))} days, so older messages may be missing.` }),
  }
}

const text = v.pipe(v.string(), v.minLength(1))
const page = (maximum: number) => v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maximum)))

function cursorOf(value: string | undefined): ChannelCursor | undefined {
  if (value === undefined) return undefined
  const cursor = decodeChannelCursor(value)
  if (!cursor) throw new ChannelsOperationError(400, "CHANNELS_CURSOR_INVALID", "The cursor is not valid.", "Use the nextCursor of the previous page.")
  return cursor
}

const channelsList = defineOperation({
  description: "List the Channels of the Agents, with the provider and how long each keeps its conversations.",
  input: v.strictObject({}),
  kind: "read",
  name: "channels.list",
  run: async (_input, context) => {
    const installed = host()
    const channels = []
    for (const [agent, handler] of Object.entries(installed.handlers)) {
      for (const channel of await handler.channels(requestOf(context), installed.options(agent, context.env))) {
        channels.push({ agent, channel: channel.id, conversations: channel.conversations, provider: channel.provider, retention: retentionOf(channel.retention) })
      }
    }
    return { channels }
  },
  section: "channels",
})

const channelsThreads = defineOperation({
  cli: { positional: ["agent", "channel"] },
  description: "List the conversation threads of a Channel, most recent first.",
  input: v.strictObject({ agent: text, channel: text, cursor: v.optional(text), limit: page(maximumThreads) }),
  kind: "read",
  name: "channels.threads",
  run: async (input, context) => {
    const installed = host()
    const handler = handlerOf(installed, input.agent)
    const mode = conversationAccess(context)
    const options = installed.options(input.agent, context.env)
    const channel = (await handler.channels(requestOf(context), options).catch((error: unknown) => { throw failureOf(error) })).find(entry => entry.id === input.channel)
    if (!channel) throw new ChannelsOperationError(404, "CHANNELS_NOT_FOUND", `The Agent ${JSON.stringify(input.agent)} has no Channel ${JSON.stringify(input.channel)}.`, "Run `vitehub channels list` to see the Channels.")
    if (!channel.conversations) throw new ChannelsOperationError(400, "CHANNELS_NO_CONVERSATIONS", `Channel ${JSON.stringify(input.channel)} has its own history collection and no per-thread conversation.`, "Use `vitehub channels replay` to work with its history.")
    const cursor = cursorOf(input.cursor)
    let threads
    try {
      threads = await handler.threads(requestOf(context), { channel: input.channel, invokers: context.surface === "agent" && mode === "participant" }, options)
    }
    catch (error) {
      throw failureOf(error)
    }
    // An Agent that reads only its own threads sees the ones that its Actor started an Invocation in.
    const ids = callerIds(context)
    const visible = context.surface === "agent" && mode === "participant" ? threads.filter(thread => thread.invokerIds.some(id => ids.includes(id))) : threads
    const key = (thread: { lastActivity: string, thread: string }) => ({ i: thread.thread, t: new Date(thread.lastActivity).getTime() })
    const ordered = [...visible].sort((left, right) => key(right).t - key(left).t || (left.thread < right.thread ? -1 : 1))
    const rest = pageAfterChannelCursor(ordered, cursor, key, (thread, from) => key(thread).t < from.t || (key(thread).t === from.t && key(thread).i > from.i))
    const size = input.limit ?? defaultThreads
    const selected = rest.slice(0, size)
    return {
      agent: input.agent,
      channel: input.channel,
      ...(rest.length > size && selected.length ? { nextCursor: encodeChannelCursor(key(selected.at(-1)!)) } : {}),
      provider: channel.provider,
      retention: retentionOf(channel.retention),
      threads: selected.map(thread => ({
        invocationCount: thread.invocationCount,
        lastMessageAt: thread.lastActivity,
        participants: thread.labels,
        thread: thread.thread,
        ...(thread.title ? { title: thread.title } : {}),
      })),
    }
  },
  section: "channels",
})

function messageView(message: ChannelConversationMessage) {
  const time = channelMessageTime(message)
  const author = channelAuthorName(message)
  const authorRecord = message.author !== null && typeof message.author === "object" ? message.author as Record<string, unknown> : {}
  return {
    attachments: message.attachments.map(attachment => ({
      ...(typeof attachment.mimeType === "string" ? { mimeType: attachment.mimeType } : {}),
      ...(typeof attachment.name === "string" ? { name: attachment.name } : {}),
      ...(typeof attachment.size === "number" ? { size: attachment.size } : {}),
      ...(typeof attachment.type === "string" ? { type: attachment.type } : {}),
      ...(typeof attachment.url === "string" ? { url: attachment.url } : {}),
    })),
    author: {
      ...(author ? { name: author } : {}),
      ...(typeof authorRecord.userId === "string" ? { id: authorRecord.userId } : {}),
      ...(authorRecord.isBot === true || message.role === "assistant" ? { isBot: true } : {}),
    },
    ...(time !== undefined ? { at: new Date(time).toISOString() } : {}),
    id: message.id,
    ...(message.invocationId ? { invocationId: message.invocationId } : {}),
    role: message.role,
    source: message.source,
    text: message.text,
  }
}

const channelsConversation = defineOperation({
  cli: { positional: ["agent", "channel", "thread"] },
  description: "Read the messages of one Channel thread in order, from transcripts, the provider history, and Invocations.",
  input: v.strictObject({ agent: text, channel: text, cursor: v.optional(text), limit: page(maximumMessages), thread: text }),
  kind: "read",
  name: "channels.conversation",
  run: async (input, context) => {
    const cursor = cursorOf(input.cursor)
    const conversation = await readConversation(context, input)
    const rest = pageAfterChannelCursor(conversation.messages, cursor, channelMessageCursor, (message, from) => channelMessageCursor(message).t > from.t)
    const size = input.limit ?? defaultMessages
    const selected = rest.slice(0, size)
    return {
      agent: conversation.agent,
      channel: conversation.channel,
      messageCount: conversation.messages.length,
      messages: selected.map(messageView),
      ...(rest.length > size && selected.length ? { nextCursor: encodeChannelCursor(channelMessageCursor(selected.at(-1)!)) } : {}),
      provider: conversation.provider,
      retention: retentionOf(conversation.retention),
      thread: conversation.threadId,
      ...(conversation.truncated ? { truncated: true } : {}),
    }
  },
  section: "channels",
})

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "thread"
}

export interface ConversationExport {
  filename: string
  format: "json" | "markdown"
  /** Attachment files, when `media` is on. Paths are relative to the file. */
  media: ChannelArchiveMedia[]
  messageCount: number
  mimeType: string
  retention: ChannelRetentionView
  text: string
  /** True when the transcript limit cut the oldest messages. */
  truncated?: boolean
}

const conversationsExport = defineOperation({
  cli: {
    command: "export",
    format: (output: ConversationExport) => output.text,
    namespace: "conversations",
    positional: ["agent", "channel", "thread"],
  },
  description: "Export one Channel conversation as Markdown or as the JSON archive, with its attachments.",
  input: v.strictObject({
    agent: text,
    channel: text,
    format: v.optional(v.picklist(["markdown", "json"]), "markdown"),
    media: v.optional(v.boolean(), false),
    thread: text,
  }),
  kind: "read",
  name: "conversations.export",
  run: async (input, context): Promise<ConversationExport> => {
    const conversation = await readConversation(context, { ...input, attachmentBytes: input.media ? maximumMediaBytes : 0 })
    const archive = channelConversationArchive(conversation)
    const { archive: files, media } = materializeChannelArchive({ ...archive, messages: conversation.messages as readonly Record<string, unknown>[] })
    const retention = retentionOf(conversation.retention)
    const exported: Omit<ConversationExport, "text"> = input.format === "json"
      ? { filename: "history.json", format: "json", media, messageCount: conversation.messages.length, mimeType: "application/json", retention }
      : { filename: `${slug(conversation.threadId)}.md`, format: "markdown", media, messageCount: conversation.messages.length, mimeType: "text/markdown", retention }
    const body = input.format === "json"
      ? `${JSON.stringify(files, null, 2)}\n`
      : renderChannelConversationMarkdown({
          agent: conversation.agent,
          channel: conversation.channel,
          exportedAt: new Date().toISOString(),
          messages: files.messages,
          provider: conversation.provider,
          retention: conversation.retention,
          threadId: conversation.threadId,
          truncated: conversation.truncated,
        })
    if (new TextEncoder().encode(body).length + media.reduce((total, file) => total + file.size, 0) > maximumArchiveBytes) {
      throw new ChannelsOperationError(413, "CHANNELS_EXPORT_TOO_LARGE", "The conversation is larger than the 35 MiB limit of an export.", "Export without media, or read the conversation page by page with `channels conversation`.")
    }
    return { ...exported, text: body, ...(conversation.truncated ? { truncated: true } : {}) }
  },
  section: "channels",
})

/** The Channel operations of `@vite-hub/agent`. The section is `channels`. */
export const agentChannelOperations: AnyOperation[] = [channelsList, channelsThreads, channelsConversation, conversationsExport] as unknown as AnyOperation[]
