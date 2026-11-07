import { compileMessageOrThrow } from "@lingui/message-utils/compileMessage"

import type { CompiledMessage } from "@lingui/message-utils/compileMessage"
import type { SourceMessages } from "./manifest.ts"
import type { TranslationRecord, TranslationRecords } from "./record-format.ts"

/** A record whose source text the code changed, matched to the message that replaced it. */
export interface PreviousTranslation {
  /** ID of the old record. */
  id: string
  record: TranslationRecord
  /** How close the old and new source texts are, from 0 to 1. */
  similarity: number
}

/** Below this, two texts say different things, and the old translation would mislead a translator. */
const threshold = 0.6

function bigrams(text: string): Map<string, number> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim()
  const result = new Map<string, number>()
  for (let index = 0; index < normalized.length - 1; index++) {
    const pair = normalized.slice(index, index + 2)
    result.set(pair, (result.get(pair) ?? 0) + 1)
  }
  return result
}

/** Dice coefficient of the character pairs of two texts. */
export function similarity(left: string, right: string): number {
  if (left === right) return 1
  const a = bigrams(left)
  const b = bigrams(right)
  let total = 0
  let shared = 0
  for (const count of a.values()) total += count
  for (const [pair, count] of b) {
    total += count
    shared += Math.min(count, a.get(pair) ?? 0)
  }
  return total === 0 ? 0 : 2 * shared / total
}

/** Placeholders such as `{name}` and tags such as `<0>`. A translation with other placeholders does not fit. */
function placeholders(text: string): string | undefined {
  const result: string[] = []
  function collect(tokens: CompiledMessage): void {
    for (const token of tokens) {
      if (typeof token === "string") {
        for (const match of token.matchAll(/<\/?(\d+)\/?>/g)) result.push(`<${match[1]}>`)
        continue
      }
      const [name, type, choices] = token
      result.push(name)
      if ((type === "plural" || type === "select" || type === "selectordinal") && choices && typeof choices === "object") {
        for (const branch of Object.values(choices)) {
          if (Array.isArray(branch)) collect(branch)
        }
      }
    }
  }
  try {
    collect(compileMessageOrThrow(text))
  }
  catch {
    // An invalid ICU message cannot establish compatible placeholders.
    return undefined
  }
  return result.sort().join(",")
}

/**
 * For each message without a translation, the unused record that it most likely replaced: the closest source text
 * with the same context and the same placeholders. Each record matches one message at most.
 */
export function findPreviousTranslations(messages: SourceMessages, records: TranslationRecords): Map<string, PreviousTranslation> {
  const missing = Object.entries(messages).filter(([id]) => !(id in records))
  const unused = Object.entries(records).filter(([id]) => !(id in messages))
  const candidates: Array<{ next: string } & PreviousTranslation> = []
  for (const [next, message] of missing) {
    const signature = placeholders(message.message)
    if (signature === undefined) continue
    for (const [id, record] of unused) {
      if ((record.context ?? "") !== (message.context ?? "") || placeholders(record.source) !== signature) continue
      const score = similarity(record.source, message.message)
      if (score >= threshold) candidates.push({ next, id, record, similarity: score })
    }
  }
  const result = new Map<string, PreviousTranslation>()
  const taken = new Set<string>()
  for (const candidate of candidates.sort((left, right) => right.similarity - left.similarity)) {
    if (result.has(candidate.next) || taken.has(candidate.id)) continue
    taken.add(candidate.id)
    result.set(candidate.next, { id: candidate.id, record: candidate.record, similarity: candidate.similarity })
  }
  return result
}
