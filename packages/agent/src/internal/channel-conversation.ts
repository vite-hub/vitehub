
export { inlineChannelArchiveMedia, materializeChannelArchive } from "@vite-hub/internal/channel-archive"
export type { ChannelArchiveMedia } from "@vite-hub/internal/channel-archive"

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
  /** A provider id established by the configured identity contract, never an arbitrary userKey suffix. */
  userId?: string
  userKey?: string
}

/** The part of an Invocation record that the stitching reads. */
export interface ChannelConversationInvocation {
  createdAt: string
  id: string
  /** The id of the person who sent the message that started it. */
  invokerId?: string
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
const unlabeledMatchMs = 60_000
const sourceRank: Record<ChannelConversationSource, number> = { provider: 0, transcript: 1, invocation: 2 }
const roleRank: Record<ChannelConversationRole, number> = { assistant: 1, system: 0, user: 0 }

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
  const time = typeof value === "string" || typeof value === "number" ? new Date(value).getTime() : Number.NaN
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

/** A provider message that the provider says is deleted. */
function providerDeleted(message: Record<string, unknown>): boolean {
  return message.deleted === true || (isRecord(message.metadata) && message.metadata.deleted === true)
}

interface Entry {
  message: ChannelConversationMessage
  order: number
  time: number | undefined
}

function messageTieOrder(message: ChannelConversationMessage): string {
  return `${roleRank[message.role]}:${sourceRank[message.source]}:${message.id}`
}

/** Time first, then role, source, and id so missing-cursor comparisons use the same stable order. */
function compareEntries(left: Entry, right: Entry): number {
  const leftOrder = messageTieOrder(left.message)
  const rightOrder = messageTieOrder(right.message)
  return (left.time ?? Number.POSITIVE_INFINITY) - (right.time ?? Number.POSITIVE_INFINITY)
    || (leftOrder < rightOrder ? -1 : leftOrder > rightOrder ? 1 : left.order - right.order)
}

function similar(left: string, right: string): boolean {
  if (left === right) return true
  return Math.min(left.length, right.length) >= 8 && (left.includes(right) || right.includes(left))
}

/**
 * Stitch the sources into one list in time order, without a message twice.
 *
 * - A transcript entry is the same message as a provider message with its platform id. A later entry with the same id
 *   replaces an earlier one, since an edit appends again. An entry without an id is the same message as any other
 *   message with the same role and text within a minute, and each message absorbs at most one such entry.
 * - A message that the provider reports as deleted is dropped, with its transcript copies.
 * - An Invocation names its trigger by platform id, or the last message from a person before it starts. Recorded reply
 *   text matches deliveries across overlapping Invocations first. Identical overlapping replies stay unlinked when
 *   their provenance is ambiguous; remaining replies up to the next person use the trigger's `invocationId`.
 * - When the journal kept content, an Invocation also adds the prompt, and each reply that no message of its window
 *   already holds.
 */
export function stitchChannelConversation(input: ChannelConversationInput): ChannelConversationMessage[] {
  const list: Entry[] = []
  const ids = new Set<string>()
  const deleted = new Set<string>()
  let order = 0
  for (const raw of input.provider) {
    const id = text(raw.id)
    if (!id || deleted.has(id)) continue
    if (providerDeleted(raw)) {
      deleted.add(id)
      ids.delete(id)
      const previous = list.findIndex(entry => entry.message.id === id)
      if (previous !== -1) list.splice(previous, 1)
      continue
    }
    if (ids.has(id)) continue
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
  const labeled = new Map<string, ChannelTranscriptEntry>()
  const unlabeled: ChannelTranscriptEntry[] = []
  for (const entry of input.transcripts) {
    if (!entry.platformMessageId) unlabeled.push(entry)
    else if (!ids.has(entry.platformMessageId) && !deleted.has(entry.platformMessageId)) labeled.set(entry.platformMessageId, entry)
  }
  const transcriptEntry = (entry: ChannelTranscriptEntry, id: string): Entry => {
    const author = entry.role === "assistant"
      ? { isBot: true, isMe: true }
      : entry.userKey ? { userId: entry.userId ?? entry.userKey, userKey: entry.userKey } : {}
    return {
      message: withTime({ attachments: [], author, id, role: entry.role, source: "transcript", text: entry.text, threadId: entry.threadId || input.threadId }, entry.timestamp),
      order: order++,
      time: entry.timestamp,
    }
  }
  for (const [id, entry] of labeled) list.push(transcriptEntry(entry, id))
  const absorbed = new Set<Entry>()
  for (const entry of unlabeled) {
    const body = normalized(entry.text)
    const same = list.find(other => !absorbed.has(other)
      && other.message.role === entry.role
      && normalized(other.message.text) === body
      && other.time !== undefined
      && Math.abs(other.time - entry.timestamp) <= unlabeledMatchMs)
    if (same) {
      absorbed.add(same)
      continue
    }
    const added = transcriptEntry(entry, `transcript:${entry.id}`)
    absorbed.add(added)
    list.push(added)
  }
  list.sort(compareEntries)
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
    list.sort(compareEntries)
    return entry
  }
  const pending = [...input.invocations].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()).map((invocation) => {
    const created = new Date(invocation.createdAt).getTime()
    const updated = new Date(invocation.updatedAt).getTime()
    let trigger = invocation.sourceMessageId ? list.findIndex(entry => entry.message.id === invocation.sourceMessageId && entry.message.role === "user") : -1
    if (trigger === -1 && !invocation.sourceMessageId && Number.isFinite(created)) {
      list.forEach((entry, position) => {
        if (entry.message.role !== "user" || entry.message.invocationId || entry.time === undefined || entry.time > created + 2_000) return
        if (trigger === -1 || entry.time >= (list[trigger]!.time ?? 0)) trigger = position
      })
    }
    if (trigger === -1 && invocation.prompt) {
      const entry = synthesize(invocation, "user", invocation.prompt, Number.isFinite(created) ? created : 0, "input")
      trigger = list.indexOf(entry)
    }
    const triggerEntry = trigger === -1 ? undefined : list[trigger]
    if (triggerEntry) mark(triggerEntry, invocation.id)
    return { created, invocation, triggerEntry, updated }
  })
  const replies = pending.flatMap(item => item.invocation.replies.map((reply, position) => ({
    ...item, body: normalized(reply), position, reply, triggerPosition: item.triggerEntry ? list.indexOf(item.triggerEntry) : -1,
  }))).filter(item => item.body)
  const matchedReplies = new Set<(typeof replies)[number]>()
  const ambiguousReplies = new Set<(typeof replies)[number]>()
  const matchedEntries = new Set<Entry>()
  const ambiguousEntries = new Set<Entry>()
  // Reserve exact deliveries across all Invocations before considering truncated text. An ambiguous exact delivery
  // prevents synthesis for every possible owner: counts alone do not establish which reply is missing.
  for (const exact of [true, false]) {
    for (const [position, entry] of list.entries()) {
      if (entry.message.role !== "assistant" || entry.message.invocationId || matchedEntries.has(entry) || ambiguousEntries.has(entry)) continue
      const body = normalized(entry.message.text)
      const candidates = replies.filter(item => position > item.triggerPosition
        && (entry.time === undefined || (entry.time >= item.created - replyWindowBeforeMs && entry.time <= item.updated + replyWindowAfterMs))
        && (exact ? body === item.body : similar(body, item.body)))
      const owners = new Set(candidates.map(item => item.invocation.id))
      if (owners.size > 1) {
        ambiguousEntries.add(entry)
        if (exact) for (const item of candidates) ambiguousReplies.add(item)
        continue
      }
      const available = candidates.find(item => !matchedReplies.has(item))
      if (!available) continue
      matchedReplies.add(available)
      matchedEntries.add(entry)
      if (owners.size === 1) mark(entry, available.invocation.id)
    }
  }
  for (const { created, invocation, triggerEntry, updated } of pending) {
    const window: Entry[] = []
    if (triggerEntry) {
      const trigger = list.indexOf(triggerEntry)
      for (let position = trigger + 1; position < list.length && list[position]!.message.role !== "user"; position++) {
        const entry = list[position]!
        if (entry.message.role === "assistant" && !entry.message.invocationId && !matchedEntries.has(entry) && !ambiguousEntries.has(entry)) window.push(entry)
      }
    }
    else {
      for (const entry of list) {
        if (entry.message.role === "assistant" && !entry.message.invocationId && !matchedEntries.has(entry) && !ambiguousEntries.has(entry) && entry.time !== undefined && entry.time >= created - replyWindowBeforeMs && entry.time <= updated + replyWindowAfterMs) window.push(entry)
      }
    }
    for (const entry of window) mark(entry, invocation.id)
    const held = list.filter(entry => entry.message.role === "assistant" && entry.message.invocationId === invocation.id && !matchedEntries.has(entry)).map(entry => normalized(entry.message.text))
    for (const item of replies.filter(item => item.invocation === invocation)) {
      if (matchedReplies.has(item) || ambiguousReplies.has(item)) continue
      // Each reply is checked on its own, so one message in the window does not hide the other replies.
      const index = held.findIndex(candidate => similar(candidate, item.body))
      if (index !== -1) {
        held.splice(index, 1)
        continue
      }
      synthesize(invocation, "assistant", item.reply, Number.isFinite(updated) ? updated : created, String(item.position).padStart(10, "0"))
    }
  }
  return list.map(entry => entry.message)
}

/** The time of the last message and the people in a stitched conversation. */
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

/** The identifiers of the people in a conversation: the user id and the transcript key of each author. */
export function channelConversationPeople(messages: readonly ChannelConversationMessage[]): string[] {
  const people = new Set<string>()
  for (const message of messages) {
    if (message.role !== "user") continue
    const author = authorOf(message)
    for (const value of [author.userId, author.userKey]) if (text(value)) people.add(String(value))
  }
  return [...people]
}

/**
 * The model header that ViteHub adds before a chat message, such as `[Tue 2026-10-13 18:06:29 +02:00 · msg 109313]`.
 * A leading `[tag]` of the person's own text is not this header.
 */
const modelHeader = /^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (?:[+-]\d{2}:\d{2}|Z|UTC)(?: · [^\]\n]*)*\]\n?/

/** The text of a user message without the model header. */
export function stripChannelModelHeader(value: string): string {
  return value.replace(modelHeader, "")
}

/** A page of items that follow a cursor, in a stable order. */
export interface ChannelCursor {
  /** The sort time of the last item of the previous page, in milliseconds. */
  t: number
  /** Its id. */
  i: string
  /** The complete same-time ordering for message cursors. Older cursors omit it. */
  o?: string
}

export function encodeChannelCursor(cursor: ChannelCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Read a cursor. Returns undefined for a value that is not one. */
export function decodeChannelCursor(value: string): ChannelCursor | undefined {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"))
    let json = binary
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
    }
    catch { /* Older cursors encoded JSON directly as Latin-1. */ }
    const parsed: unknown = JSON.parse(json)
    return isRecord(parsed) && typeof parsed.t === "number" && Number.isFinite(parsed.t) && typeof parsed.i === "string" && (parsed.o === undefined || typeof parsed.o === "string") ? { i: parsed.i, ...(typeof parsed.o === "string" ? { o: parsed.o } : {}), t: parsed.t } : undefined
  }
  catch {
    return undefined
  }
}

/**
 * The items after the cursor of an ordered list. The cursor names the last item of the previous page by id, so a page
 * stays stable when new items arrive or the provider window slides. When that item is gone, the page starts at the first
 * item that sorts after its complete key (`after`).
 */
export function pageAfterChannelCursor<T>(items: readonly T[], cursor: ChannelCursor | undefined, key: (item: T) => ChannelCursor, after: (item: T, cursor: ChannelCursor) => boolean): T[] {
  if (!cursor) return [...items]
  const index = items.findIndex(item => key(item).i === cursor.i)
  if (index !== -1) return items.slice(index + 1)
  const next = items.findIndex(item => after(item, cursor))
  return next === -1 ? [] : items.slice(next)
}

/** The cursor of a message: its time (the end of the list for a message without one) and id. */
export function channelMessageCursor(message: ChannelConversationMessage): ChannelCursor {
  return { i: message.id, o: messageTieOrder(message), t: channelMessageTime(message) ?? Number.MAX_SAFE_INTEGER }
}

function iso(value: unknown): string {
  const time = typeof value === "string" || typeof value === "number" ? new Date(value) : undefined
  return time && Number.isFinite(time.getTime()) ? time.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "unknown time"
}

/** Escape text that goes into a heading, a list item, or the text of a link, so it cannot start Markdown of its own. */
export function escapeChannelMarkdown(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[\\`*_{}[\]()#+!|<>~&]/g, "\\$&")
}

/** The target of a link: an http(s) URL, or the path of an attachment file that the export wrote. Anything else is not a link. */
function linkTarget(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (/^media\/[A-Za-z0-9._-]+$/.test(value)) return value
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href.replace(/[()<>\s]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`) : undefined
  }
  catch {
    return undefined
  }
}

function attachmentLabel(attachment: Record<string, unknown>): string {
  const name = escapeChannelMarkdown(text(attachment.name) ?? text(attachment.file) ?? text(attachment.type) ?? "attachment")
  const target = linkTarget(text(attachment.file)) ?? linkTarget(text(attachment.url))
  const detail = attachment.unavailable === true && !text(attachment.file) ? " (not included)" : ""
  return target ? `[${name}](${target})${detail}` : `${name}${detail}`
}

/** A fence longer than any run of backticks in the text, so the text cannot close it. */
function fenceFor(body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map(run => run.length))
  return "`".repeat(Math.max(3, longest + 1))
}

/**
 * Render a stitched conversation as Markdown: a title, then one block for each message with the author and time in the
 * heading, the text in a fenced block, and a list of attachments with links to their files. Names are escaped and the
 * text is fenced, so a message cannot add headings, links, or HTML to the document.
 */
export function renderChannelConversationMarkdown(input: {
  agent: string
  channel: string
  exportedAt: string
  messages: readonly Record<string, unknown>[]
  provider?: string
  retention?: { durable?: boolean, maxMessages?: number, ttlMs?: number }
  threadId: string
  truncated?: boolean
}): string {
  const lines = [
    `# Conversation ${escapeChannelMarkdown(input.threadId)}`,
    "",
    `- Agent: ${escapeChannelMarkdown(input.agent)}`,
    `- Channel: ${escapeChannelMarkdown(input.channel)}${input.provider ? ` (${escapeChannelMarkdown(input.provider)})` : ""}`,
    `- Messages: ${input.messages.length}`,
    `- Exported: ${iso(input.exportedAt)}`,
  ]
  if (input.retention && input.retention.durable === false) {
    lines.push(`- Warning: transcripts are not durable. The provider keeps ${input.retention.maxMessages ?? 100} messages for ${Math.round((input.retention.ttlMs ?? 604_800_000) / 86_400_000)} days, so older messages may be missing.`)
  }
  if (input.truncated) lines.push("- Warning: the transcript was cut at its read limit, so the oldest messages of a long conversation may be missing.")
  lines.push("")
  for (const message of input.messages) {
    const role = text(message.role) ?? "user"
    const author = channelAuthorName(message) ?? (role === "assistant" ? "Agent" : "Unknown")
    const time = channelMessageTime(message)
    lines.push(`### ${escapeChannelMarkdown(author)} · ${iso(time)}`)
    const body = typeof message.text === "string" ? message.text.trimEnd() : ""
    if (body) {
      const fence = fenceFor(body)
      lines.push("", `${fence}text`, body, fence)
    }
    const attachments = Array.isArray(message.attachments) ? message.attachments.filter(isRecord) : []
    if (attachments.length) lines.push("", ...attachments.map(attachment => `- Attachment: ${attachmentLabel(attachment)}`))
    const invocation = text(message.invocationId)
    if (invocation) lines.push("", `_Invocation ${escapeChannelMarkdown(invocation)}_`)
    lines.push("")
  }
  return `${lines.join("\n").trimEnd()}\n`
}

/** The archive of a conversation: `schemaVersion: 1`, the messages, and how long the provider keeps them. */
export function channelConversationArchive(conversation: {
  agent: string
  channel: string
  messages: readonly ChannelConversationMessage[]
  provider: string
  retention: { durable: boolean, maxMessages: number, ttlMs: number }
  threadId: string
  truncated?: boolean
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
    ...(conversation.truncated ? { truncated: true } : {}),
  }
}
