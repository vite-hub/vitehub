import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { editRecord, parseRecord, verifyRecord } from "@diglot/core"
import { readRecord, serialiseRecord } from "@diglot/store"
import { generateMessageId } from "@lingui/message-utils/generateMessageId"
import { lock } from "proper-lockfile"

import { diglotSegment, isVisible, messageSegment, recordPath, recordSegment, validateMessagePlaceholders } from "./record-format.ts"

import type { ReviewTransition } from "@diglot/core"
import type { TranslationRecord, TranslationRecords } from "./record-format.ts"

export type { MessageSegment, Origin, Review, TranslationRecord, TranslationRecords } from "./record-format.ts"
export { isVisible, messageSegment, recordPath } from "./record-format.ts"

/**
 * The message ID that the build gives a message: the first 6 base64url characters of the SHA-256 of the text and its
 * context. Two places with the same text and context share one ID and one translation. The runtime looks up messages
 * by this ID. The record of the message has Diglot's hash as its name.
 */
export function messageId(source: string, context?: string): string {
  return generateMessageId(source, context)
}

export interface RecordProblem {
  file: string
  problem: string
}

const shardRe = /^[\da-f]{2}$/
const fileRe = /^([\da-f]{16})\.json$/

async function names(folder: string): Promise<string[]> {
  return readdir(folder).then(entries => entries.sort(), (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
}

/**
 * Read the records of one locale from `<locale>/segments/<hh>/<hash>.json`, by message ID. Files that are not
 * records, or whose source does not match their hash, are problems.
 */
export async function readRecords(root: string, locale: string): Promise<{ records: TranslationRecords, problems: RecordProblem[] }> {
  const folder = join(root, locale, "segments")
  const records: TranslationRecords = {}
  const problems: RecordProblem[] = []
  for (const shard of await names(folder)) {
    if (!shardRe.test(shard)) continue
    for (const name of await names(join(folder, shard))) {
      const hash = fileRe.exec(name)?.[1]
      if (!hash) continue
      const file = join(folder, shard, name)
      let value: unknown
      try {
        value = JSON.parse(await readFile(file, "utf8"))
      }
      catch (error) {
        problems.push({ file, problem: `It is not valid JSON: ${(error as Error).message}` })
        continue
      }
      let record
      try {
        record = parseRecord(value)
      }
      catch (error) {
        problems.push({ file, problem: `It is not a Diglot record: ${(error as Error).message}` })
        continue
      }
      if (record.hash !== hash || !hash.startsWith(shard)) {
        problems.push({ file, problem: "Its `hash` does not match its path." })
        continue
      }
      if (recordSegment(record).hash !== hash) {
        problems.push({ file, problem: "Its `source` and `salt` do not match its `hash`. Edit `text` only." })
        continue
      }
      records[messageId(record.source, record.salt)] = record
    }
  }
  return { records, problems }
}

/** A message of the code: its source text and its context. */
export interface MessageRef {
  message: string
  context?: string
}

export interface ReviewInput {
  /** GitHub login of the person who saves or verifies. */
  by: string
  /**
   * The text that the person saw, or `null` when there was no translation. When the record has another text now, the
   * change is refused as `stale`. Without it, the current text is not checked.
   */
  expected?: string | null
  /** ISO 8601 timestamp. Defaults to now. */
  at?: string
}

type DiglotSegment = ReturnType<typeof diglotSegment>

async function review(root: string, locale: string, message: MessageRef, next: (current: TranslationRecord | undefined, segment: DiglotSegment) => ReviewTransition): Promise<ReviewTransition> {
  const segment = diglotSegment(messageSegment(message.message, message.context))
  const file = join(root, recordPath(locale, segment.hash))
  await mkdir(dirname(file), { recursive: true })
  // The lock covers the read, expected check and publication across CLI processes as well as in this process.
  const release = await lock(file, { realpath: false, retries: { retries: 100, minTimeout: 10, maxTimeout: 250 } })
  try {
    const transition = next(await readRecord(root, locale, segment.hash), segment)
    if (transition.ok) {
      const errors = validateMessagePlaceholders(message.message, transition.record.text)
      if (errors.length) return { ok: false, code: "invalid", message: "The translation does not preserve the message's ICU arguments.", errors }
      await publishRecord(file, transition.record)
    }
    return transition
  }
  finally {
    await release()
  }
}

/** Publish complete Diglot JSON on the same filesystem, so readers see either the old record or the new one. */
async function publishRecord(file: string, record: TranslationRecord): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, serialiseRecord(record), { flag: "wx" })
    await rename(temporary, file)
  }
  finally {
    await rm(temporary, { force: true })
  }
}

/**
 * Save a translation as a human edit with Diglot's `editRecord()`. A text that loses a placeholder of the message is
 * refused as `invalid`, and a record that changed since the person read it is refused as `stale`.
 */
export function saveTranslation(root: string, locale: string, message: MessageRef, text: string, input: ReviewInput): Promise<ReviewTransition> {
  return review(root, locale, message, (current, segment) => editRecord(current, { ...input, segment, text }))
}

/** Import an edit against its export baseline, or leave an already saved translation unchanged. */
export function importTranslation(root: string, locale: string, message: MessageRef, text: string, input: ReviewInput & { expected: string | null }): Promise<ReviewTransition> {
  return review(root, locale, message, (current, segment) => {
    // Repeated imports may have an older baseline. Decide whether they change anything under the same lock as edits.
    if (current && isVisible(current) && current.text === text) return { ok: false, code: "unchanged", message: "The translation is unchanged.", errors: [] }
    return editRecord(current, { ...input, segment, text })
  })
}

/** Mark the current translation as verified with Diglot's `verifyRecord()`. A changed text is refused as `stale`. */
export function verifyTranslation(root: string, locale: string, message: MessageRef, input: ReviewInput): Promise<ReviewTransition> {
  return review(root, locale, message, (current, segment) => verifyRecord(current, { ...input, segment }))
}

/** Delete one record by its hash. Deleting a missing record does nothing. */
export async function removeRecord(root: string, locale: string, hash: string): Promise<void> {
  await rm(join(root, recordPath(locale, hash)), { force: true })
}
