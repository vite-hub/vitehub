import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { idFromFileName, isRecord, recordPath } from "./record-format.ts"

import type { TranslationRecord, TranslationRecords } from "./record-format.ts"

export type { TranslationRecord, TranslationRecords, TranslationReview } from "./record-format.ts"
export { recordFileName, recordPath } from "./record-format.ts"

/**
 * The message ID that the build gives a message: the first 6 base64url characters of the SHA-256 of the text and its
 * context. Two places with the same text and context share one ID and one translation.
 */
export function messageId(source: string, context?: string): string {
  return createHash("sha256").update(`${source}\u001F${context ?? ""}`).digest("base64url").slice(0, 6)
}

export interface RecordProblem {
  file: string
  problem: string
}

/** Read the records of one locale. Files that are not records, or whose text does not match their name, are problems. */
export async function readRecords(root: string, locale: string): Promise<{ records: TranslationRecords, problems: RecordProblem[] }> {
  const folder = join(root, locale)
  const records: TranslationRecords = {}
  const problems: RecordProblem[] = []
  const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  await Promise.all(names.sort().map(async (name) => {
    const id = idFromFileName(name)
    if (!id) return
    const file = join(folder, name)
    let value: unknown
    try {
      value = JSON.parse(await readFile(file, "utf8"))
    }
    catch (error) {
      problems.push({ file, problem: `It is not valid JSON: ${(error as Error).message}` })
      return
    }
    if (!isRecord(value)) {
      problems.push({ file, problem: "It needs `source` and `translation` strings." })
      return
    }
    if (messageId(value.source, value.context) !== id) {
      problems.push({ file, problem: "Its `source` and `context` do not match its file name. Edit `translation` only." })
      return
    }
    records[id] = value
  }))
  return { records, problems }
}

/** Write one record. Keys keep a fixed order, so a change shows as a small diff. */
export async function writeRecord(root: string, locale: string, record: TranslationRecord): Promise<string> {
  const id = messageId(record.source, record.context)
  const file = join(root, recordPath(locale, id))
  const ordered: TranslationRecord = {
    source: record.source,
    ...(record.context === undefined ? {} : { context: record.context }),
    translation: record.translation,
    ...(record.review === undefined ? {} : { review: record.review }),
    ...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
    ...(record.by === undefined ? {} : { by: record.by }),
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(ordered, null, 2)}\n`)
  return id
}

/** Delete one record. Deleting a missing record does nothing. */
export async function removeRecord(root: string, locale: string, id: string): Promise<void> {
  await rm(join(root, recordPath(locale, id)), { force: true })
}
