import * as v from "valibot"
import type { BlobStorage } from "@vite-hub/blob"

export const consoleAttachmentCleanupPrefix = "vitehub-console-attachment-cleanup/"
const cleanupPrefix = consoleAttachmentCleanupPrefix
export const consoleAttachmentPrefix = "vitehub-console-attachments/"
const idSchema = v.pipe(v.string(), v.uuid())

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Only call for objects whose input has never been handed to a runtime. */
export async function rollbackConsoleAttachments(storage: Pick<BlobStorage, "put" | "del">, paths: string[]): Promise<Error[]> {
  const errors: Error[] = []
  for (const path of paths) {
    const id = v.parse(idSchema, path.slice(consoleAttachmentPrefix.length))
    const marker = `${cleanupPrefix}${id}`
    let recordError: Error | undefined
    try {
      const [failure] = await storage.put(marker, "pending", { contentType: "text/plain" })
      if (failure) recordError = failure
    }
    catch (failure) { recordError = asError(failure) }
    try {
      const [failure] = await storage.del(path)
      if (failure) throw failure
    }
    catch (failure) {
      errors.push(asError(failure))
      if (recordError) errors.push(recordError)
      continue
    }
    // Delete the record last. A crash or failed deletion leaves an idempotent retry.
    try {
      const [failure] = await storage.del(marker)
      if (failure) errors.push(failure)
    }
    catch (failure) { errors.push(asError(failure)) }
  }
  return errors
}

/** Drain a bounded page before accepting another upload, including after restart. */
export async function retryConsoleAttachmentCleanup(storage: Pick<BlobStorage, "list" | "del">): Promise<void> {
  const [failure, result] = await storage.list({ prefix: cleanupPrefix, limit: 100 })
  if (failure) throw failure
  for (const marker of result.blobs) {
    if (!marker.pathname.startsWith(cleanupPrefix)) continue
    const id = v.safeParse(idSchema, marker.pathname.slice(cleanupPrefix.length))
    if (!id.success) continue
    const [deleteError] = await storage.del(`${consoleAttachmentPrefix}${id.output}`)
    if (deleteError) throw deleteError
    const [recordError] = await storage.del(marker.pathname)
    if (recordError) throw recordError
  }
}
