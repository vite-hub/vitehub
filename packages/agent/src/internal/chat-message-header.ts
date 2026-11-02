// The header and reply lines that ViteHub adds to each user chat message for the model.
// Models sometimes copy them at the start of an answer, so the patterns that remove an echo live with the format.

export const chatMessageHeaderPartType = "data-chat-message-header"

const separator = " · "
const replyLinePrefix = "↪ replying to "
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export function formatChatHeaderTime(time: number, timeZone: string, short = false): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    timeZoneName: "longOffset",
    weekday: "short",
    year: "numeric",
  }).formatToParts(new Date(time)).map(part => [part.type, part.value]))
  if (short) return `${parts.weekday} ${parts.hour}:${parts.minute}`
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName?.replace("GMT", "")
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${offset}`
}

/** `[Tue 2026-11-03 13:05:22 +01:00 · msg 812 · photo AgADxyz]`, or `""` without fields. */
export function formatChatMessageHeader(fields: Array<string | undefined>): string {
  const header = fields.filter(Boolean).join(separator)
  return header ? `[${header}]` : ""
}

/** `↪ replying to your msg 109315 (Tue 18:07): "quote" · photo attached below` */
export function formatChatReplyLine(reply: { author: string, media: string[], messageId: string, quote?: string, time?: string }): string {
  const line = `${replyLinePrefix}${reply.author} msg ${reply.messageId}${reply.time ? ` (${reply.time})` : ""}${reply.quote ? `: ${reply.quote}` : ""}`
  return [line, ...reply.media].join(separator)
}

const timePattern = String.raw`(?:${weekdays.join("|")}) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}`
// A header starts with the send time, or with the message number when the time is unknown.
const headerPattern = new RegExp(String.raw`^\[(?:${timePattern}|msg [^\s\]]+)(?:${separator}[^\]\n]*)?\][ \t]*`)
const replyQuotePattern = String.raw`(?:: (?:"[^"\n]*"|\(shown above\)))?`
const replyMediaPattern = String.raw`(?:${separator}(?:photo|voice|video|file)(?: [^\s"]+)? (?:attached below|\(not shown\)))*`
// Match only the metadata fields, keeping any answer that follows on the same line.
// Quotes are not escaped in the prompt; leave ambiguous quoted lines intact.
const replyLinePattern = new RegExp(String.raw`^${replyLinePrefix}(?:your|bot|[^"\n]+?'s) msg [^\s:"]+(?: \((?:${weekdays.join("|")}) \d{2}:\d{2}\))?${replyQuotePattern}${replyMediaPattern}[ \t]*(?=[^"]*$)`)

/**
 * Find where the answer starts after echoed header and reply lines.
 * Returns undefined when more text is needed to decide.
 */
function echoedMetadataEnd(text: string, final: boolean): number | undefined {
  let start = 0
  let removed = false
  while (start < text.length) {
    const newline = text.indexOf("\n", start)
    const line = newline === -1 ? text.slice(start) : text.slice(start, newline)
    const next = newline === -1 ? text.length : newline + 1
    // An unfinished line that can still become a header or reply line waits for more text.
    if (newline === -1 && !final && (!line.trim() || line.startsWith("[") || line.startsWith("↪"))) return undefined
    if (!line.trim()) {
      start = next
      continue
    }
    const metadata = headerPattern.exec(line) ?? replyLinePattern.exec(line)
    if (metadata) {
      removed = true
      // The model may continue the answer on the metadata line.
      if (line.slice(metadata[0].length).trim()) return start + metadata[0].length
      start = next
      continue
    }
    return removed ? start : 0
  }
  if (!final) return undefined
  return removed ? text.length : 0
}

/**
 * Remove header and reply lines that the model copied at the start of its answer.
 * Call it with each chunk of a stream, then with `final` once the stream ends.
 */
export function createChatMetadataEchoFilter(): (chunk: string, final?: boolean) => string {
  let pending: string | undefined = ""
  return (chunk, final = false) => {
    if (pending === undefined) return chunk
    pending += chunk
    const end = echoedMetadataEnd(pending, final)
    if (end === undefined) return ""
    const text = pending.slice(end)
    pending = undefined
    return text
  }
}

export function stripEchoedChatMessageMetadata(text: string): string {
  return createChatMetadataEchoFilter()(text, true)
}

/** True when ViteHub gave the model message headers, so its answer can echo them. */
export function hasChatMessageHeaders(messages: ReadonlyArray<{ parts?: ReadonlyArray<{ type?: unknown }> }> | undefined): boolean {
  return !!messages?.some(message => Array.isArray(message.parts) && message.parts.some(part => part.type === chatMessageHeaderPartType))
}
