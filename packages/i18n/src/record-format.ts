// Pure helpers, so the server runtime reads records on any host.

import { hashSkeleton, recordStatus } from "@diglot/core"

import type { Placeholder, Segment, SegmentKind, TranslationRecord, ValidationTarget } from "@diglot/core"

export type { Origin, Review, TranslationRecord } from "@diglot/core"
export { parseRecordPath, recordPath } from "@diglot/store/runtime"

/** Translations of one locale, by message ID. */
export type TranslationRecords = Record<string, TranslationRecord>

/**
 * A message of the code as a Diglot segment. The record of a message has the segment hash as its name, the message
 * as its `source`, and the message context as its `salt`.
 */
export interface MessageSegment {
  /** Diglot's hash of the message and its context. */
  hash: string
  /** The message, in ICU MessageFormat. */
  skeleton: string
  /** The context of the message, when the code gives one. */
  salt?: string
  kind: "message"
  /** Diglot does not read a message as Markdown. */
  format: "plain"
  /** The positional values `{0}`, `{1}` of the message. A translation must keep each one. */
  placeholders: Placeholder[]
}

const positionalRe = /(?<!\\)\{(\d+)\}/g

/** The Diglot segment of a message. */
export function messageSegment(message: string, context?: string): MessageSegment {
  const salt = context || undefined
  let count = 0
  for (const match of message.matchAll(positionalRe)) count = Math.max(count, Number(match[1]) + 1)
  return {
    hash: hashSkeleton(message, salt, "plain"),
    skeleton: message,
    ...(salt ? { salt } : {}),
    kind: "message",
    format: "plain",
    placeholders: Array.from({ length: count }, (_, id): Placeholder => ({ id, type: "binding", source: `{${id}}` })),
  }
}

/**
 * The segment in the shape that the `@diglot/core` review functions accept. Diglot 0.2.1 has no `message` kind.
 * `validate()` reads the kind only for code comments and single-line kinds, and a plain segment is one line anyway.
 */
export function diglotSegment(segment: MessageSegment): Pick<Segment, "hash" | "skeleton" | "salt"> & ValidationTarget {
  return { ...segment, kind: segment.kind as string as SegmentKind }
}

/** The segment of the message that a record translates. */
export function recordSegment(record: Pick<TranslationRecord, "source" | "salt">): MessageSegment {
  return messageSegment(record.source, record.salt)
}

/** False for a record that a reviewer rejected or whose text fails validation. Readers see the source text then. */
export function isVisible(record: TranslationRecord): boolean {
  return recordStatus(record, diglotSegment(recordSegment(record))) !== "rejected"
}
