import type { MaybePromise } from "../types.ts"
import type { Papercut } from "./papercuts.ts"

/** One known papercut and how often Agents reported it. */
export interface PapercutOccurrence {
  /** ID of the first report. */
  id: string
  /** Message of the first report. */
  message: string
  /** Normalized terms of the first report, sorted and joined by spaces. */
  fingerprint: string
  agent?: string
  /** Reports counted, including the first one. */
  count: number
  firstReportedAt: string
  lastReportedAt: string
}

/** Remembers recent papercuts so repeats are counted instead of reported again. */
export interface PapercutIndex {
  /** Count the papercut against a recent similar report, or remember it as new with `count: 1`. */
  record: (papercut: Papercut) => MaybePromise<PapercutOccurrence>
  /** Forget a new report that was not delivered, so the next similar report is delivered. */
  forget: (id: string) => MaybePromise<void>
  /** Known papercuts, most reported first. Use it for a human digest. */
  list: () => MaybePromise<PapercutOccurrence[]>
}

/** The built-in index from `createPapercutIndex()`. It answers synchronously. */
export interface MemoryPapercutIndex extends PapercutIndex {
  record: (papercut: Papercut) => PapercutOccurrence
  forget: (id: string) => void
  list: () => PapercutOccurrence[]
}

export interface PapercutIndexOptions {
  /** How long a report stays known after its last occurrence. Defaults to 7 days. */
  windowMs?: number
  /** Minimum similarity, from 0 to 1, for two messages to count as the same papercut. Defaults to 0.4. */
  similarity?: number
  /** Maximum known papercuts kept. The least recently reported ones go first. Defaults to 500. */
  maxEntries?: number
  now?: () => number
}

// Agents describe the same failure in different words, so exact text rarely repeats.
// Terms drop volatile tokens (URLs, UUIDs, hashes, numbers, directory prefixes) and
// common or narration words. Similarity then compares the remaining term sets.
const stopWords = new Set(`
a about after again all also already an and any are as at available be because been before being both but by
can cannot could did do does doing during each either else for from had has have having here how i if in instead
into is it its itself just may me more my neither no nor not now of on once only or other our out own same should
so some still such than that the their them then there these they this those through to too under until up us
using via was we were what when where which while who will with within without would yet you your
able alternative attempt approach call called calls check checking continue continuing currently current
fallback first focused keep keeping later local next normal proceed proceeding retry retrying rather run running
safely trying try use used uses work working
`.split(/\s+/).filter(Boolean))

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1)
  return word
}

/** Normalized terms of a papercut message. */
export function papercutTerms(message: string): Set<string> {
  const text = message.toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, " ")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/g, " ")
    .replace(/(?:[\w.@~-]*\/)+([\w.@-]+)/g, " $1 ")
    .replace(/\b\w*\d\w*\b/g, " ")
  const terms = new Set<string>()
  for (const word of text.split(/[^a-z]+/)) {
    if (word.length < 2 || stopWords.has(word)) continue
    terms.add(stem(word))
  }
  return terms
}

/** Dice similarity of two term sets, from 0 to 1. */
export function papercutSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const term of left) if (right.has(term)) shared++
  return (2 * shared) / (left.size + right.size)
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`[vitehub] createPapercutIndex({ ${name} }) must be a positive number.`)
  return value
}

/** In-memory papercut index. It lives as long as the server process. */
export function createPapercutIndex(options: PapercutIndexOptions = {}): MemoryPapercutIndex {
  const windowMs = positive(options.windowMs, 7 * 24 * 60 * 60 * 1000, "windowMs")
  const maxEntries = positive(options.maxEntries, 500, "maxEntries")
  const threshold = options.similarity ?? 0.4
  if (!(threshold > 0 && threshold <= 1)) throw new TypeError("[vitehub] createPapercutIndex({ similarity }) must be greater than 0 and at most 1.")
  const now = options.now || Date.now
  const entries = new Map<string, { occurrence: PapercutOccurrence, terms: Set<string>, lastAt: number }>()

  function prune(time: number) {
    for (const [id, entry] of entries) if (time - entry.lastAt > windowMs) entries.delete(id)
  }

  return {
    record(papercut) {
      const time = now()
      prune(time)
      const terms = papercutTerms(papercut.message)
      const agent = papercut.agent?.name
      let best: { occurrence: PapercutOccurrence, terms: Set<string>, lastAt: number } | undefined
      let bestScore = 0
      for (const entry of entries.values()) {
        if (entry.occurrence.agent !== agent) continue
        const score = papercutSimilarity(terms, entry.terms)
        if (score > bestScore) { best = entry; bestScore = score }
      }
      const reportedAt = new Date(time).toISOString()
      if (best && bestScore >= threshold) {
        best.occurrence.count++
        best.occurrence.lastReportedAt = reportedAt
        best.lastAt = time
        entries.delete(best.occurrence.id)
        entries.set(best.occurrence.id, best)
        return { ...best.occurrence }
      }
      const occurrence: PapercutOccurrence = {
        id: papercut.id,
        message: papercut.message,
        fingerprint: [...terms].sort().join(" "),
        ...(agent ? { agent } : {}),
        count: 1,
        firstReportedAt: reportedAt,
        lastReportedAt: reportedAt,
      }
      entries.set(papercut.id, { occurrence, terms, lastAt: time })
      for (const id of entries.keys()) {
        if (entries.size <= maxEntries) break
        entries.delete(id)
      }
      return { ...occurrence }
    },
    forget(id) { entries.delete(id) },
    list() {
      prune(now())
      return [...entries.values()].map(entry => ({ ...entry.occurrence })).sort((left, right) => right.count - left.count)
    },
  }
}
