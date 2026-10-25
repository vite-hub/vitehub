import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { channelsConsoleHost, ChannelUnknownError } from "./channels-console-host.ts"
import {
  channelAuthorName,
  channelConversationArchive,
  channelMessageTime,
  materializeChannelArchive,
  renderChannelConversationMarkdown,
  summarizeChannelConversation,
} from "./internal/channel-conversation.ts"

import type { AnyOperation, OperationContext } from "@vite-hub/internal/operations"
import type { ChannelsConsoleHost } from "./channels-console-host.ts"
import type { ChannelArchiveMedia, ChannelConversationMessage } from "./internal/channel-conversation.ts"
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
const defaultThreads = 25
const maximumThreads = 100
const defaultMessages = 100
const maximumMessages = 500

function host(): ChannelsConsoleHost {
  const installed = channelsConsoleHost()
  if (!installed) {
    throw new ChannelsOperationError(
      503,
      "CHANNELS_HOST_UNAVAILABLE",
      "The Channel webhook routes of this app have not started in this process.",
      "Use an app with a persistent libSQL Agent State (the default in `vite dev`). It installs the Channel reader when the server starts.",
    )
  }
  return installed
}

function agentOf(installed: ChannelsConsoleHost, agent: string) {
  const handler = installed.handlers[agent]
  const definition = installed.agents[agent]
  if (!handler || !definition) throw new ChannelsOperationError(404, "CHANNELS_NOT_FOUND", `The app has no Agent named ${JSON.stringify(agent)} with Channels.`, "Run `vitehub channels list` to see the Agents and Channels.")
  return { definition, handler }
}

function requestOf(context: OperationContext): Request {
  return context.request ?? new Request("http://vitehub.local/_vitehub/channels")
}

async function readConversation(context: OperationContext, input: { agent: string, attachmentBytes?: number, channel: string, thread: string }): Promise<AgentChannelConversation> {
  const installed = host()
  const { handler } = agentOf(installed, input.agent)
  try {
    return await handler.conversation(requestOf(context), { attachmentBytes: input.attachmentBytes ?? 0, channel: input.channel, threadId: input.thread }, installed.options(input.agent))
  }
  catch (error) {
    if (error instanceof ChannelUnknownError) {
      throw new ChannelsOperationError(404, "CHANNELS_NOT_FOUND", error.message, "Run `vitehub channels list` to see the Channels that keep conversations.")
    }
    if (error instanceof ChannelsOperationError) throw error
    throw new ChannelsOperationError(502, "CHANNELS_PROVIDER_FAILED", `The provider history of thread ${JSON.stringify(input.thread)} could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function retentionOf(retention: AgentChannelRetention) {
  return {
    durable: retention.durable,
    maxMessages: retention.maxMessages,
    mode: retention.durable ? "durable-transcripts" as const : "provider-window" as const,
    transcripts: retention.transcripts,
    ttlMs: retention.ttlMs,
    ...(retention.durable
      ? {}
      : { warning: `Transcripts are not durable. The provider keeps ${retention.maxMessages} messages for ${Math.max(1, Math.round(retention.ttlMs / 86_400_000))} days, so older messages may be missing.` }),
  }
}

const text = v.pipe(v.string(), v.minLength(1))
const page = (maximum: number) => v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maximum)))

function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  const offset = Number(cursor)
  if (!Number.isInteger(offset) || offset < 0) throw new ChannelsOperationError(400, "CHANNELS_CURSOR_INVALID", "The cursor is not valid.", "Use the nextCursor of the previous page.")
  return offset
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
      for (const channel of await handler.channels(requestOf(context), installed.options(agent))) {
        channels.push({ agent, channel: channel.id, conversations: channel.conversations, provider: channel.provider, retention: retentionOf(channel.retention) })
      }
    }
    return { channels }
  },
  section: "channels",
  user: false,
})

const channelsThreads = defineOperation({
  cli: { positional: ["agent", "channel"] },
  description: "List the conversation threads of a Channel, most recent first.",
  input: v.strictObject({ agent: text, channel: text, cursor: v.optional(text), limit: page(maximumThreads) }),
  kind: "read",
  name: "channels.threads",
  run: async (input, context) => {
    const installed = host()
    const { definition } = agentOf(installed, input.agent)
    const channel = (await agentOf(installed, input.agent).handler.channels(requestOf(context), installed.options(input.agent))).find(entry => entry.id === input.channel)
    if (!channel) throw new ChannelsOperationError(404, "CHANNELS_NOT_FOUND", `The Agent ${JSON.stringify(input.agent)} has no Channel ${JSON.stringify(input.channel)}.`, "Run `vitehub channels list` to see the Channels.")
    if (!channel.conversations) throw new ChannelsOperationError(400, "CHANNELS_NO_CONVERSATIONS", `Channel ${JSON.stringify(input.channel)} has its own history collection and no per-thread conversation.`, "Use `vitehub channels replay` to work with its history.")
    const threads = new Map<string, { invocationCount: number, lastActivity: string, participants: Set<string>, title?: string, titleAt?: string }>()
    const invocations = definition.invocations
    let cursor: string | undefined
    if (invocations) {
      do {
        const list = await invocations.list({ agentName: input.agent, ...(cursor ? { cursor } : {}), limit: 1000 })
        for (const summary of list.invocations) {
          if (summary.origin !== channel.origin || !summary.threadId) continue
          const thread = threads.get(summary.threadId) ?? { invocationCount: 0, lastActivity: summary.updatedAt, participants: new Set<string>() }
          thread.invocationCount += 1
          if (summary.updatedAt > thread.lastActivity) thread.lastActivity = summary.updatedAt
          const label = summary.annotations?.triggeredBy
          if (typeof label === "string" && label.trim()) thread.participants.add(label.trim())
          if (summary.title && (!thread.titleAt || summary.createdAt > thread.titleAt)) {
            thread.title = summary.title
            thread.titleAt = summary.createdAt
          }
          threads.set(summary.threadId, thread)
        }
        cursor = list.cursor
      } while (cursor)
    }
    const ordered = [...threads.entries()].sort((left, right) => right[1].lastActivity.localeCompare(left[1].lastActivity))
    const offset = offsetOf(input.cursor)
    const size = input.limit ?? defaultThreads
    const selected = ordered.slice(offset, offset + size)
    const rows = await Promise.all(selected.map(async ([thread, summary]) => {
      const row: Record<string, unknown> = {
        invocationCount: summary.invocationCount,
        lastMessageAt: summary.lastActivity,
        participants: [...summary.participants],
        thread,
        ...(summary.title ? { title: summary.title } : {}),
      }
      try {
        const conversation = await readConversation(context, { agent: input.agent, channel: input.channel, thread })
        const { lastMessageAt, participants } = summarizeChannelConversation(conversation.messages)
        row.messageCount = conversation.messages.length
        if (lastMessageAt) row.lastMessageAt = lastMessageAt
        if (participants.length) row.participants = participants
      }
      catch (error) {
        row.error = error instanceof Error ? error.message : String(error)
      }
      return row
    }))
    return {
      agent: input.agent,
      channel: input.channel,
      ...(offset + size < ordered.length ? { nextCursor: String(offset + size) } : {}),
      provider: channel.provider,
      retention: retentionOf(channel.retention),
      threads: rows,
    }
  },
  section: "channels",
  user: false,
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
    const conversation = await readConversation(context, input)
    const offset = offsetOf(input.cursor)
    const size = input.limit ?? defaultMessages
    return {
      agent: conversation.agent,
      channel: conversation.channel,
      messageCount: conversation.messages.length,
      messages: conversation.messages.slice(offset, offset + size).map(messageView),
      ...(offset + size < conversation.messages.length ? { nextCursor: String(offset + size) } : {}),
      provider: conversation.provider,
      retention: retentionOf(conversation.retention),
      thread: conversation.threadId,
    }
  },
  section: "channels",
  user: false,
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
  retention: ReturnType<typeof retentionOf>
  text: string
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
    if (input.format === "json") {
      return {
        filename: "history.json",
        format: "json",
        media,
        messageCount: conversation.messages.length,
        mimeType: "application/json",
        retention,
        text: `${JSON.stringify(files, null, 2)}\n`,
      }
    }
    return {
      filename: `${slug(conversation.threadId)}.md`,
      format: "markdown",
      media,
      messageCount: conversation.messages.length,
      mimeType: "text/markdown",
      retention,
      text: renderChannelConversationMarkdown({
        agent: conversation.agent,
        channel: conversation.channel,
        exportedAt: new Date().toISOString(),
        messages: files.messages,
        provider: conversation.provider,
        retention: conversation.retention,
        threadId: conversation.threadId,
      }),
    }
  },
  section: "channels",
  user: false,
})

/** The Channel operations of `@vite-hub/agent`. The section is `channels`. */
export const agentChannelOperations: AnyOperation[] = [channelsList, channelsThreads, channelsConversation, conversationsExport] as unknown as AnyOperation[]
