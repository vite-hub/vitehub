/**
 * One conversation of a Channel thread, stitched from three sources: the provider messages (the thread cache or the
 * provider's own history), the durable transcripts of the people in it, and the Invocations that answered. The result is
 * the message list of the `channels history` archive (`schemaVersion: 1`) with three added fields on each message:
 * `role`, `source`, and `invocationId`.
 */

export type ChannelConversationRole = "assistant" | "system" | "user"
export type ChannelConversationSource = "invocation" | "provider" | "transcript"

/** A message of the archive. Provider messages keep every field that Chat SDK gave them. */
export interface ChannelConversationMessage extends Record<string, unknown> {
  attachments: Record<string, unknown>[]
  id: string
  /** The Invocation that this message started or answered. */
  invocationId?: string
  role: ChannelConversationRole
  source: ChannelConversationSource
  text: string
  threadId: string
}

/** The part of a Chat SDK transcript entry that the stitching reads. */
export interface ChannelTranscriptEntry {
  id: string
  platform?: string
  platformMessageId?: string
  role: ChannelConversationRole
  text: string
  threadId: string
  timestamp: number
  userKey?: string
}

/** The part of an Invocation record that the stitching reads. */
export interface ChannelConversationInvocation {
  createdAt: string
  id: string
  /** The text of the message that started it, when the journal keeps content. */
  prompt?: string
  /** The texts that the Invocation sent to the thread, in order, when the journal keeps content. */
  replies: readonly string[]
  /** The provider id of the message that started it. The Channel delivery records it. */
  sourceMessageId?: string
  status: string
  title?: string
  updatedAt: string
}

export interface ChannelConversationInput {
  invocations: readonly ChannelConversationInvocation[]
  provider: readonly Record<string, unknown>[]
  threadId: string
  transcripts: readonly ChannelTranscriptEntry[]
}

const replyWindowBeforeMs = 5_000
const replyWindowAfterMs = 60_000
const transcriptMatchMs = 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/** The time of a message in milliseconds, or undefined when the message has none. */
export function channelMessageTime(message: Record<string, unknown>): number | undefined {
  const metadata = isRecord(message.metadata) ? message.metadata : undefined
  const value = metadata?.dateSent ?? message.at ?? message.createdAt
  const time = typeof value === "string" || typeof value === "number" ? new Date(value).getTime() : NaN
  return Number.isFinite(time) ? time : undefined
}

function authorOf(message: Record<string, unknown>): Record<string, unknown> {
  return isRecord(message.author) ? message.author : {}
}

function providerRole(message: Record<string, unknown>): ChannelConversationRole {
  return authorOf(message).isMe === true ? "assistant" : "user"
}

function withTime(message: ChannelConversationMessage, time: number | undefined): ChannelConversationMessage {
  if (time === undefined) return message
  const metadata = isRecord(message.metadata) ? message.metadata : {}
  return { ...message, metadata: { ...metadata, dateSent: new Date(time).toISOString() } }
}

interface Entry {
  message: ChannelConversationMessage
  order: number
  time: number | undefined
}

function byTime(left: Entry, right: Entry): number {
  return (left.time ?? Number.POSITIVE_INFINITY) - (right.time ?? Number.POSITIVE_INFINITY) || left.order - right.order
}

/**
 * Stitch the sources into one list in time order, without a message twice.
 *
 * - A transcript entry is the same message as a provider message with its platform id. One without an id matches a
 *   provider message with the same role and text within a minute.
 * - An Invocation names the message that started it by its platform id, so that message and the replies after it, up to
 *   the next message from a person, carry its `invocationId`. Without an id, the last message from a person before it starts it.
 * - When the journal kept content, an Invocation also adds the prompt or the reply that no other source still has.
 */
export function stitchChannelConversation(input: ChannelConversationInput): ChannelConversationMessage[] {
  const list: Entry[] = []
  const ids = new Set<string>()
  let order = 0
  for (const raw of input.provider) {
    const id = text(raw.id)
    if (!id || ids.has(id)) continue
    ids.add(id)
    list.push({
      message: {
        ...raw,
        attachments: Array.isArray(raw.attachments) ? raw.attachments.filter(isRecord) : [],
        id,
        role: providerRole(raw),
        source: "provider",
        text: typeof raw.text === "string" ? raw.text : "",
        threadId: text(raw.threadId) ?? input.threadId,
      },
      order: order++,
      time: channelMessageTime(raw),
    })
  }
  for (const entry of input.transcripts) {
    if (entry.platformMessageId && ids.has(entry.platformMessageId)) continue
    const key = entry.platformMessageId ?? `transcript:${entry.id}`
    if (ids.has(key)) continue
    if (!entry.platformMessageId) {
      const duplicate = list.some(other => other.message.source === "provider"
        && other.message.role === entry.role
        && normalized(other.message.text) === normalized(entry.text)
        && other.time !== undefined
        && Math.abs(other.time - entry.timestamp) <= transcriptMatchMs)
      if (duplicate) continue
    }
    ids.add(key)
    const author = entry.role === "assistant"
      ? { isBot: true, isMe: true }
      : entry.userKey ? { userId: entry.userKey.replace(/^[^:]+:/, ""), userKey: entry.userKey } : {}
    list.push({
      message: withTime({ attachments: [], author, id: key, role: entry.role, source: "transcript", text: entry.text, threadId: entry.threadId || input.threadId }, entry.timestamp),
      order: order++,
      time: entry.timestamp,
    })
  }
  list.sort(byTime)
  const mark = (entry: Entry, invocationId: string) => {
    if (!entry.message.invocationId) entry.message = { ...entry.message, invocationId }
  }
  const synthesize = (invocation: ChannelConversationInvocation, role: "assistant" | "user", body: string, at: number, suffix: string): Entry => {
    const entry: Entry = {
      message: withTime({
        attachments: [],
        author: role === "assistant" ? { isBot: true, isMe: true } : {},
        id: `invocation:${invocation.id}:${suffix}`,
        invocationId: invocation.id,
        role,
        source: "invocation",
        text: body,
        threadId: input.threadId,
      }, at),
      order: order++,
      time: at,
    }
    list.push(entry)
    list.sort(byTime)
    return entry
  }
  for (const invocation of [...input.invocations].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    const created = new Date(invocation.createdAt).getTime()
    const updated = new Date(invocation.updatedAt).getTime()
    let trigger = invocation.sourceMessageId ? list.findIndex(entry => entry.message.id === invocation.sourceMessageId && entry.message.role === "user") : -1
    if (trigger === -1 && !invocation.sourceMessageId && Number.isFinite(created)) {
      // Without the platform id, the last message from a person before the Invocation started it.
      list.forEach((entry, position) => {
        if (entry.message.role !== "user" || entry.message.invocationId || entry.time === undefined || entry.time > created + 2_000) return
        if (trigger === -1 || entry.time >= (list[trigger]!.time ?? 0)) trigger = position
      })
    }
    if (trigger === -1 && invocation.prompt) {
      const at = Number.isFinite(created) ? created : 0
      const entry = synthesize(invocation, "user", invocation.prompt, at, "input")
      trigger = list.indexOf(entry)
    }
    const triggerEntry = trigger === -1 ? undefined : list[trigger]
    if (triggerEntry) mark(triggerEntry, invocation.id)
    // The replies are the messages from the Agent after the trigger, up to the next message from a person.
    const window: Entry[] = []
    if (triggerEntry) {
      for (let position = trigger + 1; position < list.length && list[position]!.message.role !== "user"; position++) {
        if (list[position]!.message.role === "assistant" && !list[position]!.message.invocationId) window.push(list[position]!)
      }
    }
    else {
      for (const entry of list) {
        if (entry.message.role === "assistant" && !entry.message.invocationId && entry.time !== undefined && entry.time >= created - replyWindowBeforeMs && entry.time <= updated + replyWindowAfterMs) window.push(entry)
      }
    }
    for (const entry of window) mark(entry, invocation.id)
    invocation.replies.forEach((reply, position) => {
      const body = normalized(reply)
      if (!body) return
      // The window already holds the reply when a message with its text carries this Invocation.
      if (list.some(entry => entry.message.role === "assistant" && entry.message.invocationId === invocation.id && normalized(entry.message.text) === body)) return
      // A reply without its own message is edited into another one, such as a placeholder, so only the journal has its text.
      if (window.some(entry => normalized(entry.message.text) !== "" && normalized(entry.message.text) !== "...")) return
      synthesize(invocation, "assistant", reply, Number.isFinite(updated) ? updated : created, String(position))
    })
  }
  return list.map(entry => entry.message)
}

/** The time of the last message and the people in a stitched conversation, for the thread list. */
export function summarizeChannelConversation(messages: readonly ChannelConversationMessage[]): { lastMessageAt?: string, participants: string[] } {
  const participants: string[] = []
  let last: number | undefined
  for (const message of messages) {
    const time = channelMessageTime(message)
    if (time !== undefined && (last === undefined || time > last)) last = time
    if (message.role !== "user") continue
    const name = channelAuthorName(message)
    if (name && !participants.includes(name)) participants.push(name)
  }
  return { ...(last !== undefined ? { lastMessageAt: new Date(last).toISOString() } : {}), participants }
}

/** The name to show for the author of a message. */
export function channelAuthorName(message: Record<string, unknown>): string | undefined {
  const author = authorOf(message)
  if (author.isMe === true) return "Agent"
  return text(author.fullName) ?? text(author.userName) ?? text(author.name) ?? text(author.userId)
}

function iso(value: unknown): string {
  const time = typeof value === "string" || typeof value === "number" ? new Date(value) : undefined
  return time && Number.isFinite(time.getTime()) ? time.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "unknown time"
}

function attachmentLabel(attachment: Record<string, unknown>): string {
  const name = text(attachment.name) ?? text(attachment.file) ?? text(attachment.type) ?? "attachment"
  const target = text(attachment.file) ?? text(attachment.url)
  const detail = attachment.unavailable === true && !text(attachment.file) ? " (not included)" : ""
  return target ? `[${name}](${target})${detail}` : `${name}${detail}`
}

/**
 * Render a stitched conversation as Markdown: a title, then one block for each message with the author and time in the
 * heading, the text, and a list of attachments with links to their files.
 */
export function renderChannelConversationMarkdown(input: {
  agent: string
  channel: string
  exportedAt: string
  messages: readonly Record<string, unknown>[]
  provider?: string
  retention?: { durable?: boolean, maxMessages?: number, ttlMs?: number }
  threadId: string
}): string {
  const lines = [
    `# Conversation ${input.threadId}`,
    "",
    `- Agent: ${input.agent}`,
    `- Channel: ${input.channel}${input.provider ? ` (${input.provider})` : ""}`,
    `- Messages: ${input.messages.length}`,
    `- Exported: ${iso(input.exportedAt)}`,
  ]
  if (input.retention && input.retention.durable === false) {
    lines.push(`- Warning: transcripts are not durable. The provider keeps ${input.retention.maxMessages ?? 100} messages for ${Math.round((input.retention.ttlMs ?? 604_800_000) / 86_400_000)} days, so older messages may be missing.`)
  }
  lines.push("")
  for (const message of input.messages) {
    const role = text(message.role) ?? "user"
    const author = channelAuthorName(message) ?? (role === "assistant" ? "Agent" : "Unknown")
    const time = channelMessageTime(message)
    lines.push(`### ${author} · ${iso(time !== undefined ? time : undefined)}`)
    const body = typeof message.text === "string" ? message.text.trimEnd() : ""
    if (body) lines.push("", ...body.split("\n").map(line => line))
    const attachments = Array.isArray(message.attachments) ? message.attachments.filter(isRecord) : []
    if (attachments.length) lines.push("", ...attachments.map(attachment => `- Attachment: ${attachmentLabel(attachment)}`))
    const invocation = text(message.invocationId)
    if (invocation) lines.push("", `_Invocation ${invocation}_`)
    lines.push("")
  }
  return `${lines.join("\n").trimEnd()}\n`
}

export interface ChannelArchiveMedia {
  base64: string
  mimeType?: string
  /** Path in the archive directory, such as `media/0001-meal.jpg`. */
  path: string
  size: number
}

function safeMediaName(name: unknown, mimeType: unknown, index: number): string {
  const extension = typeof mimeType === "string" ? ({ "image/gif": ".gif", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" } as Record<string, string>)[mimeType] ?? "" : ""
  const source = typeof name === "string" && name.trim() ? name.trim().split(/[\\/]/).at(-1)! : `attachment-${index}${extension}`
  return source.replace(/[^A-Za-z0-9._-]+/g, "-") || `attachment-${index}`
}

function base64Size(value: string): number {
  const clean = value.replace(/\s/g, "")
  return Math.max(0, Math.floor(clean.length * 3 / 4) - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0))
}

/**
 * Move the attachment data of an archive into files, as `channels history` writes them: each attachment keeps its
 * fields except `data`, and gains `file: "media/<number>-<name>"`. The messages keep their order.
 */
export function materializeChannelArchive<T extends { messages: readonly Record<string, unknown>[] }>(archive: T): { archive: T, media: ChannelArchiveMedia[] } {
  const media: ChannelArchiveMedia[] = []
  const messages = archive.messages.map((message) => {
    if (!Array.isArray(message.attachments)) return message
    const attachments = message.attachments.map((attachment) => {
      if (!isRecord(attachment) || typeof attachment.data !== "string") return attachment
      const { data, ...rest } = attachment
      const path = `media/${String(media.length + 1).padStart(4, "0")}-${safeMediaName(rest.name, rest.mimeType, media.length + 1)}`
      media.push({ base64: data, ...(typeof rest.mimeType === "string" ? { mimeType: rest.mimeType } : {}), path, size: base64Size(data) })
      return { ...rest, file: path }
    })
    return { ...message, attachments }
  })
  return { archive: { ...archive, messages }, media }
}

/** The archive of a conversation: `schemaVersion: 1`, the messages, and how long the provider keeps them. */
export function channelConversationArchive(conversation: {
  agent: string
  channel: string
  messages: readonly ChannelConversationMessage[]
  provider: string
  retention: { durable: boolean, maxMessages: number, ttlMs: number }
  threadId: string
}, exportedAt: string = new Date().toISOString()): Record<string, unknown> & { messages: readonly ChannelConversationMessage[] } {
  return {
    agent: conversation.agent,
    channel: conversation.channel,
    exportedAt,
    messages: conversation.messages,
    provider: conversation.provider,
    retention: {
      durable: conversation.retention.durable,
      maxMessages: conversation.retention.maxMessages,
      ttlMs: conversation.retention.ttlMs,
    },
    schemaVersion: 1,
    threadId: conversation.threadId,
  }
}
