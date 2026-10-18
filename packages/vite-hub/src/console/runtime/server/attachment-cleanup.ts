import * as v from "valibot"
import { vitehubOwnedPrefix } from "@vite-hub/internal/owned-paths"
import type { BlobStorage } from "@vite-hub/blob"

const consolePrefix = `${vitehubOwnedPrefix}console/`
export const consoleAttachmentPrefix = `${consolePrefix}attachments/`
export const consoleAttachmentCleanupPrefix = `${consolePrefix}cleanup/`
export const consoleAttachmentQuarantinePrefix = `${consolePrefix}quarantine/`
const cleanupPrefixes = [consoleAttachmentCleanupPrefix, "vitehub-console-attachment-cleanup/"] as const
const quarantinePrefixes = [consoleAttachmentQuarantinePrefix, "vitehub-console-attachment-quarantine/"] as const
export const legacyConsoleAttachmentPrefix = "vitehub-console-attachments/"
const cleanupPrefix = consoleAttachmentCleanupPrefix
const idSchema = v.pipe(v.string(), v.uuid())

class CorruptCleanupRecord extends Error {
  constructor(readonly body: string) {
    super("Invalid attachment cleanup batch record")
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Only call for objects whose input has never been handed to a runtime. */
export async function rollbackConsoleAttachments(storage: Pick<BlobStorage, "put" | "del">, paths: string[]): Promise<Error[]> {
  const errors: Error[] = []
  if (!paths.length) return errors
  const ids = paths.map(path => v.parse(idSchema, path.slice(consoleAttachmentPrefix.length)))
  // A single object registers the entire batch before any per-object work starts.
  const marker = ids.length === 1 ? `${cleanupPrefix}${ids[0]}` : `${cleanupPrefix}batch/${crypto.randomUUID()}`
  let recordError: Error | undefined
  try {
    const [failure] = await storage.put(marker, JSON.stringify(ids), { contentType: "application/json" })
    if (failure) recordError = failure
  }
  catch (failure) { recordError = asError(failure) }
  for (const path of paths) {
    try {
      const [failure] = await storage.del(path)
      if (failure) throw failure
    }
    catch (failure) { errors.push(asError(failure)) }
  }
  if (errors.length) {
    if (recordError) errors.push(recordError)
    return errors
  }
  // Keep the whole batch until every deletion succeeds; retries are idempotent.
  try {
    const [failure] = await storage.del(marker)
    if (failure) errors.push(failure)
  }
  catch (failure) { errors.push(asError(failure)) }
  return errors
}

/** Drain a bounded page before accepting another upload, including after restart. */
export async function retryConsoleAttachmentCleanup(storage: Pick<BlobStorage, "list" | "del" | "get" | "put">): Promise<void> {
  const pages = await Promise.all(cleanupPrefixes.map(async (cleanupPrefix, index) => {
    const [failure, result] = await storage.list({ prefix: cleanupPrefix, limit: 100 })
    if (failure) throw failure
    return result.blobs.map(marker => ({ marker, cleanupPrefix, quarantinePrefix: quarantinePrefixes[index]! }))
  }))
  let processed = 0
  for (let offset = 0; processed < 100; offset++) {
    let visited = false
    for (const page of pages) {
      const entry = page[offset]
      if (!entry) continue
      visited = true
      if (processed >= 100) break
      const { marker, cleanupPrefix, quarantinePrefix } = entry
      if (!marker.pathname.startsWith(cleanupPrefix)) continue
      let ids: string[] | undefined
      try { ids = await cleanupIds(storage, marker.pathname, cleanupPrefix) }
      catch (error) {
        if (!(error instanceof CorruptCleanupRecord)) throw error
        const [writeError] = await storage.put(`${quarantinePrefix}${marker.pathname.slice(cleanupPrefix.length)}`, error.body, { contentType: "application/json" })
        if (writeError) throw writeError
        const [deleteError] = await storage.del(marker.pathname)
        if (deleteError) throw deleteError
        continue
      }
      if (!ids) continue
      processed++
      for (const id of ids) {
        const attachmentPrefix = cleanupPrefix === cleanupPrefixes[1] ? legacyConsoleAttachmentPrefix : consoleAttachmentPrefix
        const [deleteError] = await storage.del(`${attachmentPrefix}${id}`)
        if (deleteError) throw deleteError
      }
      const [recordError] = await storage.del(marker.pathname)
      if (recordError) throw recordError
    }
    if (!visited) break
  }
}

async function cleanupIds(storage: Pick<BlobStorage, "get">, pathname: string, cleanupPrefix: string): Promise<string[] | undefined> {
  const suffix = pathname.slice(cleanupPrefix.length)
  if (!suffix.startsWith("batch/")) {
    const parsed = v.safeParse(idSchema, suffix)
    return parsed.success ? [parsed.output] : undefined
  }
  if (!v.safeParse(idSchema, suffix.slice(6)).success) return undefined
  const [failure, blob] = await storage.get(pathname)
  if (failure) throw failure
  if (!blob) return undefined
  // An unreadable record may still own pending deletions. Fail closed so its
  // images cannot be reused and then removed when a later retry reads it.
  const body = await blob.text()
  let data: unknown
  try { data = JSON.parse(body) }
  catch { throw new CorruptCleanupRecord(body) }
  const parsed = v.safeParse(v.pipe(v.array(idSchema), v.minLength(1), v.maxLength(10)), data)
  if (!parsed.success) throw new CorruptCleanupRecord(body)
  return parsed.output
}

/** Batch records must also prevent an abandoned image from gaining a new owner. */
export async function isConsoleAttachmentPendingCleanup(storage: Pick<BlobStorage, "get" | "list">, id: string): Promise<boolean> {
  for (const [index, cleanupPrefix] of cleanupPrefixes.entries()) {
    const [failure, marker] = await storage.get(`${cleanupPrefix}${id}`)
    if (failure) throw failure
    if (marker) return true
    let cursor: string | undefined
    do {
      const [listError, result] = await storage.list({ prefix: `${cleanupPrefix}batch/`, limit: 100, cursor })
      if (listError) throw listError
      for (const blob of result.blobs) {
        if (blob.pathname.startsWith(`${cleanupPrefix}batch/`) && (await cleanupIds(storage, blob.pathname, cleanupPrefix))?.includes(id)) return true
      }
      if (!result.hasMore) break
      if (!result.cursor || result.cursor === cursor) throw new Error("Attachment cleanup listing did not advance")
      cursor = result.cursor
    } while (cursor)
    const [quarantineError, quarantine] = await storage.list({ prefix: quarantinePrefixes[index], limit: 1 })
    if (quarantineError) throw quarantineError
    if (quarantine.blobs.length) throw new Error("Attachment cleanup ownership is quarantined")
  }
  return false
}
