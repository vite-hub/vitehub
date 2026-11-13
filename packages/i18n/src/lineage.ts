import { messagePlaceholders } from "./placeholders.ts"
import { isVisible } from "./record-format.ts"

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
  try {
    return messagePlaceholders(text).join()
  }
  catch {
    // An invalid ICU message cannot establish compatible placeholders.
    return undefined
  }
}

/**
 * For each message without a translation, the unused record that it most likely replaced: the closest source text
 * with the same context and the same placeholders. Each record matches one message at most. A match can move to
 * its next closest candidate when that lets another missing message use its only compatible record.
 */
export function findPreviousTranslations(messages: SourceMessages, records: TranslationRecords): Map<string, PreviousTranslation> {
  const missing = Object.entries(messages).filter(([id]) => !records[id] || !isVisible(records[id]))
  const unused = Object.entries(records).filter(([id, record]) => !(id in messages) && isVisible(record))
  const candidates: Array<{ next: string } & PreviousTranslation> = []
  for (const [next, message] of missing) {
    const signature = placeholders(message.message)
    if (signature === undefined) continue
    for (const [id, record] of unused) {
      if ((record.salt ?? "") !== (message.context ?? "") || placeholders(record.source) !== signature) continue
      const score = similarity(record.source, message.message)
      if (score >= threshold) candidates.push({ next, id, record, similarity: score })
    }
  }
  const result = new Map<string, PreviousTranslation>()
  const taken = new Map<string, string>()
  const choices = new Map<string, PreviousTranslation[]>()
  for (const candidate of candidates.sort((left, right) => right.similarity - left.similarity)) {
    const options = choices.get(candidate.next) ?? []
    options.push(candidate)
    choices.set(candidate.next, options)
    if (result.has(candidate.next) || taken.has(candidate.id)) continue
    taken.set(candidate.id, candidate.next)
    result.set(candidate.next, { id: candidate.id, record: candidate.record, similarity: candidate.similarity })
  }

  // Keep the closest matches unless moving one makes room for an unmatched message.
  function match(next: string, visited: Set<string>): boolean {
    for (const candidate of choices.get(next) ?? []) {
      if (visited.has(candidate.id)) continue
      visited.add(candidate.id)
      const owner = taken.get(candidate.id)
      if (owner !== undefined && !match(owner, visited)) continue
      taken.set(candidate.id, next)
      result.set(next, { id: candidate.id, record: candidate.record, similarity: candidate.similarity })
      return true
    }
    return false
  }
  for (const [next] of missing) {
    if (!result.has(next)) match(next, new Set())
  }
  return result
}
