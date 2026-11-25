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

const threshold = 0.6

interface Bigrams {
  text: string
  pairs: Map<string, number>
  total: number
}

function bigrams(text: string): Bigrams {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim()
  const result = new Map<string, number>()
  for (let index = 0; index < normalized.length - 1; index++) {
    const pair = normalized.slice(index, index + 2)
    result.set(pair, (result.get(pair) ?? 0) + 1)
  }
  return { text, pairs: result, total: Math.max(0, normalized.length - 1) }
}

function dice(left: Bigrams, right: Bigrams): number {
  if (left.text === right.text) return 1
  const total = left.total + right.total
  if (total === 0) return 0
  let shared = 0
  for (const [pair, count] of right.pairs) shared += Math.min(count, left.pairs.get(pair) ?? 0)
  return 2 * shared / total
}

/** Dice coefficient of the character pairs of two texts. */
export function similarity(left: string, right: string): number {
  return left === right ? 1 : dice(bigrams(left), bigrams(right))
}

function placeholders(text: string): string | undefined {
  const names = messagePlaceholders(text)
  return names instanceof Error ? undefined : names.join()
}

/**
 * For each message without a translation, the unused record that it most likely replaced: the closest source text
 * with the same context and the same placeholders. Each record matches one message at most. A match can move to
 * its next closest candidate when that lets another missing message use its only compatible record.
 */
export function findPreviousTranslations(messages: SourceMessages, records: TranslationRecords): Map<string, PreviousTranslation> {
  const missing = Object.entries(messages).filter(([id]) => !records[id] || !isVisible(records[id]))
  if (!missing.length) return new Map()
  const contexts = new Set(missing.map(([, message]) => message.context ?? ""))
  const unused = new Map<string, Array<{ id: string, record: TranslationRecord, grams: Bigrams }>>()
  for (const [id, record] of Object.entries(records)) {
    if (id in messages || !contexts.has(record.salt ?? "") || !isVisible(record)) continue
    const signature = placeholders(record.source)
    if (signature === undefined) continue
    const key = JSON.stringify([record.salt ?? "", signature])
    const group = unused.get(key) ?? []
    group.push({ id, record, grams: bigrams(record.source) })
    unused.set(key, group)
  }
  const candidates: Array<{ next: string } & PreviousTranslation> = []
  for (const [next, message] of missing) {
    const signature = placeholders(message.message)
    if (signature === undefined) continue
    const group = unused.get(JSON.stringify([message.context ?? "", signature]))
    if (!group) continue
    const grams = bigrams(message.message)
    for (const { id, record, grams: previous } of group) {
      const score = dice(previous, grams)
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
