import type { AttachmentPart, Message } from "../messages.ts"
import { chatMessageHeaderPartType } from "./chat-message-header.ts"
import { isRuntimeRecord } from "./runtime-type.ts"

/** `current`: the message that started the run, or one coalesced into it. `history`: an earlier message sent again. */
export type InputAttachmentOrigin = "current" | "history"

/** Why an attachment did not reach the model. */
export type InputAttachmentSkipReason =
  | "byte-budget"
  | "max-age"
  | "max-images"
  | "no-data"
  | "not-image"
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
  /** The file that the provider runtime reads. Drivers that pass bytes in the model call have none. */
  path?: string
}

export interface SkippedInputAttachment extends InputAttachmentEntry {
  reason: InputAttachmentSkipReason
}

/** What a Driver did with every attachment of the messages it sent to the model. */
export interface InputAttachmentsReport {
  sent: SentInputAttachment[]
  skipped: SkippedInputAttachment[]
}

/** A history attachment that chat message selection left out, kept in the message header's `data.omittedAttachments`. */
export interface ChatOmittedAttachment {
  id?: string
  mediaType: string
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
    && (value.name === undefined || typeof value.name === "string")
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
    if (part.type !== chatMessageHeaderPartType || !isRuntimeRecord(part.data) || !Array.isArray(part.data.omittedAttachments)) return []
    return part.data.omittedAttachments.filter(isChatOmittedAttachment).map(item => ({
      mediaType: item.mediaType,
      ...(message.id ? { messageId: message.id } : {}),
      ...(item.name ? { name: item.name } : {}),
      origin: "history" as const,
      ...(item.id ? { partId: item.id } : {}),
      reason: item.reason,
    }))
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
