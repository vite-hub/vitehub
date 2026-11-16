import { defineOperation, table } from "@vite-hub/internal/operations"
import { isRuntimeDiagnostic } from "@vite-hub/runtime"
import * as v from "valibot"

import { agentDiagnostics } from "./agent-diagnostics.ts"
import { channelsConsoleHost } from "./channels-console-host.ts"
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

import type { AnyOperation, OperationContext, OperationDefinition } from "@vite-hub/internal/operations"
import type { ChannelsConsoleHost } from "./channels-console-host.ts"
import type { AgentChannelStatus } from "./internal/channel-status.ts"
import type { ChannelArchiveMedia, ChannelConversationMessage, ChannelCursor } from "./internal/channel-conversation.ts"
import type { AgentChannelConversation, AgentChannelRetention } from "./server/routes.ts"

/** The HTTP status that the CLI, the Console, and Agents report for each code of a failed Channels operation. */
const channelsOperationStatus: Readonly<Record<string, number>> = {
  AGENT_CHANNELS_ADAPTER_MISSING: 500,
  AGENT_CHANNELS_CURSOR_INVALID: 400,
  AGENT_CHANNELS_EXPORT_TOO_LARGE: 413,
  AGENT_CHANNELS_FORBIDDEN: 403,
  AGENT_CHANNELS_HOST_UNAVAILABLE: 503,
  AGENT_CHANNELS_NO_CONVERSATIONS: 400,
  AGENT_CHANNELS_NO_STATUS: 400,
  AGENT_CHANNELS_NOT_FOUND: 404,
  AGENT_CHANNELS_PROVIDER_FAILED: 502,
  AGENT_CHANNELS_THREAD_UNKNOWN: 404,
}

/** A Channels code with the HTTP status that the operation boundary reads. */
function channelsFailure<T extends Error & { code: string }>(error: T): T & { status: number } {
  return Object.assign(error, { status: channelsOperationStatus[error.code] ?? 500 })
}

const maximumMediaBytes = 25 * 1024 * 1024
const maximumArchiveBytes = 35 * 1024 * 1024
const defaultThreads = 25
const maximumThreads = 100
const defaultMessages = 100
const maximumMessages = 500

function host(): ChannelsConsoleHost {
  const installed = channelsConsoleHost()
  if (!installed) {
    throw channelsFailure(agentDiagnostics.AGENT_CHANNELS_HOST_UNAVAILABLE({ read: "host" }))
  }
  return installed
}

function handlerOf(installed: ChannelsConsoleHost, agent: string) {
  const handler = installed.handlers[agent]
  if (!handler) throw channelsFailure(agentDiagnostics.AGENT_CHANNELS_NOT_FOUND({ agent: JSON.stringify(agent), problem: "agent" }))
  return handler
}

function requestOf(context: OperationContext): Request {
  return context.request ?? new Request("http://vitehub.local/_vitehub/channels")
}

/** The failure of a read as a coded operation failure. */
function failureOf(error: unknown): Error {
  if (isRuntimeDiagnostic(error) && Object.hasOwn(channelsOperationStatus, error.code)) return channelsFailure(error)
  return channelsFailure(agentDiagnostics.AGENT_CHANNELS_PROVIDER_FAILED({ detail: error instanceof Error ? error.message : String(error), cause: error }))
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
    throw channelsFailure(agentDiagnostics.AGENT_CHANNELS_FORBIDDEN({ problem: "conversations" }))
  }
  return context.conversations
}

function assertParticipant(context: OperationContext, participants: readonly string[]): void {
  const ids = callerIds(context)
  if (ids.some(id => participants.includes(id))) return
  throw channelsFailure(agentDiagnostics.AGENT_CHANNELS_FORBIDDEN({ problem: ids.length ? "participant" : "identity" }))
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
  /** Present when older messages may be missing. A simulated Channel has none. */
  warning?: string
}

// A simulated Channel has no provider history to lose: its chat page keeps the messages in browser memory, and a
// reload starts a new thread. So it gets no warning about the provider window.
function retentionOf(retention: AgentChannelRetention, simulated: boolean): ChannelRetentionView {
  return {
    durable: retention.durable,
    maxMessages: retention.maxMessages,
    mode: retention.durable ? "durable-transcripts" : "provider-window",
    transcripts: retention.transcripts,
    ttlMs: retention.ttlMs,
    ...(retention.durable || simulated
      ? {}
      : { warning: `Transcripts are not durable. The provider keeps ${retention.maxMessages} messages for ${Math.max(1, Math.round(retention.ttlMs / 86_400_000))} days, so older messages may be missing.` }),
  }
}

const text = v.pipe(v.string(), v.minLength(1))
const page = (maximum: number) => v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maximum)))

function cursorOf(value: string | undefined): ChannelCursor | undefined {
  if (value === undefined) return undefined
  const cursor = decodeChannelCursor(value)
  if (!cursor) throw channelsFailure(agentDiagnostics.AGENT_CHANNELS_CURSOR_INVALID())
  return cursor
}

interface ChannelListEntry extends ChannelTarget {
  conversations: boolean
  provider: string
  retention: ChannelRetentionView
  /** True when the Channel runs on the simulated chat of `agent.channels.simulate`. */
  simulated: boolean
  /** The path of the chat page of a simulated Channel. */
  simulator?: string
}

function formatChannels({ channels }: { channels: readonly ChannelListEntry[] }): string {
  if (channels.length === 0) return "No Channels.\n"
  return `${table([
    ["AGENT", "CHANNEL", "PROVIDER", "HISTORY", "CHAT PAGE"],
    ...channels.map(entry => [entry.agent, entry.channel, entry.simulated ? `${entry.provider} (simulated)` : entry.provider, entry.retention.mode, entry.simulator ?? "-"]),
  ])}\n`
}

const channelsList = defineOperation({
  cli: { format: formatChannels },
  description: "List the Channels of the Agents, with the provider, how long each keeps its conversations, and the chat page of a simulated Channel.",
  input: v.strictObject({}),
  kind: "read",
  name: "channels.list",
  run: async (_input, context) => {
    const installed = host()
    const channels: ChannelListEntry[] = []
    for (const [agent, handler] of Object.entries(installed.handlers)) {
      for (const channel of await handler.channels(requestOf(context), installed.options(agent, context.env))) {
        channels.push({
          agent,
          channel: channel.id,
          conversations: channel.conversations,
          provider: channel.provider,
          retention: retentionOf(channel.retention, channel.simulated),
          simulated: channel.simulated,
          ...(channel.simulator ? { simulator: channel.simulator } : {}),
        })
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
    if (!channel) throw channelsFailure(agentDiagnostics.AGENT_CHANNELS_NOT_FOUND({ agent: JSON.stringify(input.agent), channel: JSON.stringify(input.channel), problem: "channel" }))
    if (!channel.conversations) throw channelsFailure(agentDiagnostics.AGENT_CHANNELS_NO_CONVERSATIONS({ channel: JSON.stringify(input.channel) }))
    const cursor = cursorOf(input.cursor)
    let threads
    try {
      threads = await handler.threads(requestOf(context), { channel: input.channel, invokers: context.surface === "agent" && mode === "participant" }, options)
    }
    catch (error) {
      throw failureOf(error)
    }
    // Retained transcript/provider authors can participate without starting their own Invocation.
    const ids = callerIds(context)
    const visible = []
    for (const thread of threads) {
      if (context.surface === "agent" && mode === "participant" && !thread.invokerIds.some(id => ids.includes(id))) {
        let conversation
        try {
          conversation = await handler.conversation(requestOf(context), { attachmentBytes: 0, channel: input.channel, threadId: thread.thread }, options)
        }
        catch (error) {
          throw failureOf(error)
        }
        if (!conversation.participants.some(id => ids.includes(id))) continue
      }
      visible.push(thread)
    }
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
      retention: retentionOf(channel.retention, channel.simulated),
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

const channelsStatus = defineOperation({
  cli: { positional: ["agent", "channel"] },
  description: "Show the sync health of a Channel that reads a provider cursor, such as Gmail, with the messages it retries and the messages it skipped.",
  input: v.strictObject({ agent: text, channel: text }),
  kind: "read",
  name: "channels.status",
  run: async (input, context) => {
    // Errors name message IDs of the mailbox, so an Agent needs access to every conversation.
    if (context.surface === "agent" && context.conversations !== "all") {
      throw channelsFailure(agentDiagnostics.AGENT_CHANNELS_FORBIDDEN({ problem: "status" }))
    }
    const installed = host()
    const handler = handlerOf(installed, input.agent)
    let status
    try {
      status = await handler.channelStatus(requestOf(context), input.channel, installed.options(input.agent, context.env))
    }
    catch (error) {
      throw failureOf(error)
    }
    if (!status) throw channelsFailure(agentDiagnostics.AGENT_CHANNELS_NO_STATUS({ channel: JSON.stringify(input.channel) }))
    return { agent: input.agent, channel: input.channel, ...status }
  },
  section: "channels",
})

interface ChannelMessageView {
  attachments: { mimeType?: string, name?: string, size?: number, type?: string, url?: string }[]
  author: { id?: string, isBot?: boolean, name?: string }
  at?: string
  id: string
  invocationId?: string
  role: ChannelConversationMessage["role"]
  source: ChannelConversationMessage["source"]
  text: string
}

function messageView(message: ChannelConversationMessage): ChannelMessageView {
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
    const rest = pageAfterChannelCursor(conversation.messages, cursor, channelMessageCursor, (message, from) => {
      const key = channelMessageCursor(message)
      return key.t > from.t || (key.t === from.t && from.o !== undefined && key.o !== undefined && key.o > from.o)
    })
    const size = input.limit ?? defaultMessages
    const selected = rest.slice(0, size)
    return {
      agent: conversation.agent,
      channel: conversation.channel,
      messageCount: conversation.messages.length,
      messages: selected.map(messageView),
      ...(rest.length > size && selected.length ? { nextCursor: encodeChannelCursor(channelMessageCursor(selected.at(-1)!)) } : {}),
      provider: conversation.provider,
      retention: retentionOf(conversation.retention, conversation.simulated),
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
    const retention = retentionOf(conversation.retention, conversation.simulated)
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
          ...(conversation.simulated ? {} : { retention: conversation.retention }),
          threadId: conversation.threadId,
          truncated: conversation.truncated,
        })
    if (new TextEncoder().encode(body).length + media.reduce((total, file) => total + file.size, 0) > maximumArchiveBytes) {
      throw channelsFailure(agentDiagnostics.AGENT_CHANNELS_EXPORT_TOO_LARGE({ archive: "export" }))
    }
    return { ...exported, text: body, ...(conversation.truncated ? { truncated: true } : {}) }
  },
  section: "channels",
})

interface ChannelTarget {
  agent: string
  channel: string
}

interface ChannelPage {
  cursor?: string
  limit?: number
}

interface ChannelPageResult extends ChannelTarget {
  nextCursor?: string
  provider: string
  retention: ChannelRetentionView
}

type ChannelOperationDefinitions = readonly [
  OperationDefinition<Record<string, never>, { channels: ChannelListEntry[] }>,
  OperationDefinition<ChannelTarget & ChannelPage, ChannelPageResult & {
    threads: { invocationCount: number, lastMessageAt: string, participants: string[], thread: string, title?: string }[]
  }>,
  OperationDefinition<ChannelTarget & ChannelPage & { thread: string }, ChannelPageResult & {
    messageCount: number
    messages: ChannelMessageView[]
    thread: string
    truncated?: boolean
  }>,
  OperationDefinition<ChannelTarget & { format: "json" | "markdown", media: boolean, thread: string }, ConversationExport>,
  OperationDefinition<ChannelTarget, ChannelTarget & AgentChannelStatus>,
]

/** The Channel operations of `@vite-hub/agent`. The section is `channels`. */
export const agentChannelOperations: ChannelOperationDefinitions = [channelsList, channelsThreads, channelsConversation, conversationsExport, channelsStatus] as const satisfies readonly AnyOperation[]
