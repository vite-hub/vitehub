import type { AttachmentPart, Message } from "../messages.ts"
import { chatMessageHeaderPartType } from "./chat-message-header.ts"
import { isRuntimeRecord } from "./runtime-type.ts"

/** `current`: the message that started the run, or one coalesced into it. `history`: an earlier message sent again. */
export type InputAttachmentOrigin = "current" | "history"

/** Why chat selection or the Driver left out an attachment. */
export type InputAttachmentSkipReason =
  | "byte-budget"
  | "max-age"
  | "max-images"
  | "no-data"
  | "not-image"
  | "not-inline"
  | "sandbox"
  | `fetch-failed:${string}`

export interface InputAttachmentEntry {
  /** Declared or read size. A skipped attachment has it only when the size was known. */
  bytes?: number
  mediaType: string
  messageId?: string
  name?: string
  origin: InputAttachmentOrigin
  partId?: string
}

export interface SentInputAttachment extends InputAttachmentEntry {
  bytes: number
}

export interface SkippedInputAttachment extends InputAttachmentEntry {
  reason: InputAttachmentSkipReason
}

/** The attachments the model received and those left out. */
export interface InputAttachmentsReport {
  sent: SentInputAttachment[]
  skipped: SkippedInputAttachment[]
}

/** A history attachment that chat message selection left out, kept in the message header's `data.omittedAttachments`. */
export interface ChatOmittedAttachment {
  id?: string
  mediaType: string
  messageId?: string
  name?: string
  reason: Extract<InputAttachmentSkipReason, "max-age" | "max-images" | "not-image">
}

const selectionReasons = new Set<string>(["max-age", "max-images", "not-image"])

function isChatOmittedAttachment(value: unknown): value is ChatOmittedAttachment {
  return isRuntimeRecord(value)
    && typeof value.mediaType === "string"
    && typeof value.reason === "string"
    && selectionReasons.has(value.reason)
    && (value.id === undefined || typeof value.id === "string")
    && (value.messageId === undefined || typeof value.messageId === "string")
    && (value.name === undefined || typeof value.name === "string")
}

export function chatOmittedAttachments(data: unknown): ChatOmittedAttachment[] {
  return isRuntimeRecord(data) && Array.isArray(data.omittedAttachments)
    ? data.omittedAttachments.filter(isChatOmittedAttachment)
    : []
}

export function retainedUserMessages(messages: Message[], messageId?: string): Message[] {
  const index = messageId
    ? messages.findIndex(message => message.id === messageId)
    : messages.findLastIndex(message => message.role === "user")
  const chat = messages[index]?.metadata?.chat
  const skippedCount = isRuntimeRecord(chat) ? chat.skippedCount : undefined
  if (typeof skippedCount !== "number" || !Number.isSafeInteger(skippedCount) || skippedCount <= 0) return []
  return messages.slice(Math.max(0, index - skippedCount), index).filter(message => message.role === "user")
}

export function inputAttachmentEntry(part: AttachmentPart, message: Message | undefined, origin: InputAttachmentOrigin): InputAttachmentEntry {
  return {
    ...(typeof part.size === "number" ? { bytes: part.size } : {}),
    mediaType: part.mediaType,
    ...(message?.id ? { messageId: message.id } : {}),
    ...(part.name ? { name: part.name } : {}),
    origin,
    ...(part.id ? { partId: part.id } : {}),
  }
}

/** History attachments that chat message selection (`triggerHistory.maxImages` and `maxAgeMs`) left out of these messages. */
export function selectedOutAttachments(messages: readonly Message[]): SkippedInputAttachment[] {
  return messages.flatMap(message => message.parts.flatMap((part) => {
    if (part.type !== chatMessageHeaderPartType) return []
    return chatOmittedAttachments(part.data).map((item): SkippedInputAttachment => {
      const messageId = item.messageId ?? message.id
      return {
        mediaType: item.mediaType,
        ...(messageId ? { messageId } : {}),
        ...(item.name ? { name: item.name } : {}),
        origin: "history",
        ...(item.id ? { partId: item.id } : {}),
        reason: item.reason,
      }
    })
  }))
}

/** The error code, HTTP status, or error name of a failed attachment read. */
export function attachmentFetchFailure(error: unknown): `fetch-failed:${string}` {
  if (!isRuntimeRecord(error)) return "fetch-failed:unknown"
  const code = typeof error.code === "string" && error.code
    ? error.code
    : typeof error.status === "number" ? String(error.status) : typeof error.statusCode === "number" ? String(error.statusCode) : undefined
  return `fetch-failed:${code ?? (error instanceof Error ? error.name : "unknown")}`
}
