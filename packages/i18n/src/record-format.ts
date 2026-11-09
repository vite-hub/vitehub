// Pure helpers, so the server runtime reads records on any host.

import { hashSkeleton, recordStatus } from "@diglot/core"
import { compileMessageOrThrow } from "@lingui/message-utils/compileMessage"

import type { Placeholder, Segment, SegmentKind, TranslationRecord, ValidationIssue, ValidationTarget } from "@diglot/core"
import type { CompiledIcuChoices, CompiledMessage } from "@lingui/message-utils/compileMessage"

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

type TagCounts = Map<string, { min: number, max: number }>

/** Sequential messages add occurrences; ICU alternatives take their minimum and maximum. */
function addTagCounts(target: TagCounts, counts: TagCounts) {
  for (const [tag, count] of counts) {
    const previous = target.get(tag)
    target.set(tag, { min: (previous?.min ?? 0) + count.min, max: (previous?.max ?? 0) + count.max })
  }
}

/** Read ICU arguments and rich-text components from the messages that Lingui will render. */
function messagePlaceholders(message: string) {
  const names = new Set<string>()
  const visit = (tokens: CompiledMessage, parents: string[]): { parents: string[], tags: TagCounts } => {
    const tags: TagCounts = new Map()
    for (const token of tokens) {
      if (typeof token === "string") {
        for (const [, closing, name, empty] of token.matchAll(/<(\/?)(\d+)(\/?)>/g)) {
          if (closing) {
            if (empty || parents.pop() !== name) throw new Error(`Unpaired rich-text tag </${name}>`)
          }
          else {
            const placeholder = empty ? `Rich-text tag <${name}/>` : `Rich-text tag <${name}>...</${name}>`
            names.add(placeholder)
            addTagCounts(tags, new Map([[placeholder, { min: 1, max: 1 }]]))
            if (!empty) parents.push(name!)
          }
        }
        continue
      }
      names.add(`ICU argument {${token[0]}}`)
      if (token[1] === "plural" || token[1] === "select" || token[1] === "selectordinal") {
        let next: string[] | undefined
        const branches: TagCounts[] = []
        for (const branch of Object.values(token[2] as CompiledIcuChoices)) {
          if (!Array.isArray(branch)) continue
          const result = visit(branch, [...parents])
          if (next && next.join(",") !== result.parents.join(",")) throw new Error("Unbalanced rich-text tags across ICU choices")
          next = result.parents
          branches.push(result.tags)
        }
        parents = next ?? parents
        const choices: TagCounts = new Map()
        for (const tag of new Set(branches.flatMap(branch => [...branch.keys()]))) {
          choices.set(tag, {
            min: Math.min(...branches.map(branch => branch.get(tag)?.min ?? 0)),
            max: Math.max(...branches.map(branch => branch.get(tag)?.max ?? 0)),
          })
        }
        addTagCounts(tags, choices)
      }
    }
    return { parents, tags }
  }
  const result = visit(compileMessageOrThrow(message), [])
  if (result.parents.length) throw new Error("Unclosed rich-text tag")
  return { names, tags: result.tags }
}

/** Diglot 0.2.1 understands numeric bindings only. Check all runtime placeholders as well. */
export function validateMessagePlaceholders(source: string, text: string): ValidationIssue[] {
  try {
    const required = messagePlaceholders(source)
    const translated = messagePlaceholders(text)
    return [
      ...[...required.names].filter(name => !translated.names.has(name)).map((name): ValidationIssue => ({ code: "missing-placeholder", message: `${name} is missing` })),
      ...[...translated.names].filter(name => !required.names.has(name)).map((name): ValidationIssue => ({ code: "unknown-placeholder", message: `Unknown ${name}` })),
      // Preserve occurrence counts, both on every source path and on paths that repeat a component.
      ...[...required.tags].filter(([tag, count]) => {
        const actual = translated.tags.get(tag)
        return actual && (actual.min < count.min || actual.max < count.max)
      }).map(([tag]): ValidationIssue => ({ code: "missing-placeholder", message: `${tag} has missing occurrences` })),
    ]
  }
  catch (error) {
    return [{ code: "brace", message: `Invalid message: ${(error as Error).message}` }]
  }
}

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
    && validateMessagePlaceholders(record.source, record.text).length === 0
}
