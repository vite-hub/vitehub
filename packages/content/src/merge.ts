import { diffArrays } from "diff"

import { parseDocumentFile, renderDocumentFile } from "./documents.ts"

import type { ContentFormat } from "./documents.ts"

/** What a three-way merge of one document could not decide: a field, or the body. */
export type ContentMergeConflict = { field: string } | { body: true }

export type ContentMergeResult = { text: string } | { conflicts: ContentMergeConflict[] }

/** A change of one side against the base: base tokens `[start, end)` became side tokens `[sideStart, sideEnd)`. */
interface Hunk {
  start: number
  end: number
  sideStart: number
  sideEnd: number
}

/** Words and the whitespace between them, so that edits to different words of one paragraph merge. */
function tokens(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? []
}

function hunks(base: string[], side: string[]): Hunk[] {
  const found: Hunk[] = []
  let at = 0
  let sideAt = 0
  let open: Hunk | undefined
  for (const change of diffArrays(base, side)) {
    const count = change.value.length
    if (!change.added && !change.removed) {
      if (open) found.push(open)
      open = undefined
      at += count
      sideAt += count
      continue
    }
    open ??= { start: at, end: at, sideStart: sideAt, sideEnd: sideAt }
    if (change.removed) {
      at += count
      open.end = at
    }
    else {
      sideAt += count
      open.sideEnd = sideAt
    }
  }
  if (open) found.push(open)
  // Repeated whitespace can split a replacement into a deletion and an insertion. Keep that pair atomic, without
  // joining independent replacements (one of which the other side may have made identically).
  const atomic: Hunk[] = []
  for (const hunk of found) {
    const previous = atomic.at(-1)
    if (previous && base.slice(previous.end, hunk.start).every(token => !/\S/.test(token))
      && ((previous.sideStart === previous.sideEnd && hunk.start === hunk.end)
        || (previous.start === previous.end && hunk.sideStart === hunk.sideEnd))) {
      previous.end = hunk.end
      previous.sideEnd = hunk.sideEnd
    }
    else atomic.push(hunk)
  }
  return atomic
}

/** The tokens of `side` for base tokens `[start, end)`, given the side's hunks inside that range. */
function replay(base: string[], side: string[], changes: readonly Hunk[], start: number, end: number): string {
  let text = ""
  let at = start
  for (const hunk of changes) {
    text += base.slice(at, hunk.start).join("") + side.slice(hunk.sideStart, hunk.sideEnd).join("")
    at = hunk.end
  }
  return text + base.slice(at, end).join("")
}

/**
 * Merge the body word by word, as `diff3` does by line. Changes that touch the same or neighbouring base words
 * conflict unless both sides made the same change. Whitespace counts as a word, so edits to two words with a space
 * between them merge.
 */
function mergeBody(base: string, ours: string, theirs: string): string | undefined {
  if (ours === theirs || theirs === base) return ours
  if (ours === base) return theirs
  const baseTokens = tokens(base)
  const sides = [
    { tokens: tokens(ours), hunks: [] as Hunk[] },
    { tokens: tokens(theirs), hunks: [] as Hunk[] },
  ] as const
  sides[0].hunks.push(...hunks(baseTokens, sides[0].tokens))
  sides[1].hunks.push(...hunks(baseTokens, sides[1].tokens))
  const all = [...sides[0].hunks.map(hunk => ({ hunk, side: 0 as const })), ...sides[1].hunks.map(hunk => ({ hunk, side: 1 as const }))]
    .sort((left, right) => left.hunk.start - right.hunk.start || left.hunk.end - right.hunk.end)
  let merged = ""
  let at = 0
  for (let index = 0; index < all.length;) {
    // One group: hunks whose base ranges overlap or touch.
    let start = all[index]!.hunk.start
    let end = all[index]!.hunk.end
    const group = [all[index]!]
    for (index++; index < all.length && all[index]!.hunk.start <= end; index++) {
      group.push(all[index]!)
      end = Math.max(end, all[index]!.hunk.end)
      start = Math.min(start, all[index]!.hunk.start)
    }
    merged += baseTokens.slice(at, start).join("")
    const changed = [0, 1].map(side => group.filter(entry => entry.side === side).map(entry => entry.hunk))
    const texts = changed.map((hunks, side) => replay(baseTokens, sides[side as 0 | 1].tokens, hunks, start, end))
    if (changed[0]!.length && changed[1]!.length && texts[0] !== texts[1]) return undefined
    merged += changed[0]!.length ? texts[0] : texts[1]
    at = end
  }
  return merged + baseTokens.slice(at).join("")
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Merge fields one by one. A field that both sides set to different values is a conflict. */
function mergeFields(base: Record<string, unknown>, ours: Record<string, unknown>, theirs: Record<string, unknown>): { fields: Record<string, unknown>, conflicts: string[] } {
  const fields: Record<string, unknown> = Object.create(null)
  const conflicts: string[] = []
  // The draft's field order first, then fields that only the other side added.
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)])) {
    const [b, o, t] = [base, ours, theirs].map(fields => Object.hasOwn(fields, key) ? fields[key] : undefined)
    if (!same(o, t) && !same(t, b) && !same(o, b)) {
      conflicts.push(key)
      continue
    }
    const value = same(o, b) ? t : o
    if (value !== undefined) fields[key] = value
  }
  return { fields, conflicts }
}

/** The frontmatter block of a Markdown file, exactly as written, when the body is the rest of the file. */
function frontmatterBlock(text: string, body: string): string | undefined {
  const source = text.startsWith("﻿") ? text.slice(1) : text
  return source.endsWith(body) ? source.slice(0, source.length - body.length) : undefined
}

/**
 * Merge three versions of one stored document: `ours` (the draft), `theirs` (published), and their common `base`.
 * Fields merge one by one and a Markdown body merges word by word. The result keeps the bytes of a side wherever that
 * side's version is taken, so a file that a person wrote by hand keeps its formatting. Unparseable input conflicts.
 */
export function mergeContentDocument(base: string, ours: string, theirs: string, format: ContentFormat): ContentMergeResult {
  if (ours === theirs || theirs === base) return { text: ours }
  if (ours === base) return { text: theirs }
  const b = parseDocumentFile(base, format)
  const o = parseDocumentFile(ours, format)
  const t = parseDocumentFile(theirs, format)
  if (!("frontmatter" in b) || !("frontmatter" in o) || !("frontmatter" in t)) return { conflicts: [{ body: true }] }
  const fields = mergeFields(b.frontmatter, o.frontmatter, t.frontmatter)
  const body = format === "markdown" ? mergeBody(b.body, o.body, t.body) : ""
  const conflicts: ContentMergeConflict[] = fields.conflicts.map(field => ({ field }))
  if (body === undefined) conflicts.push({ body: true })
  if (conflicts.length) return { conflicts }
  if (format !== "markdown") return { text: same(fields.fields, o.frontmatter) ? ours : same(fields.fields, t.frontmatter) ? theirs : renderDocumentFile(fields.fields, "", format) }
  const head = same(fields.fields, o.frontmatter)
    ? frontmatterBlock(ours, o.body)
    : same(fields.fields, t.frontmatter) ? frontmatterBlock(theirs, t.body) : undefined
  return { text: head === undefined ? renderDocumentFile(fields.fields, body!, format) : head + body! }
}
