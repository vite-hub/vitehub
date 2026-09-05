import * as v from "valibot"
import { createMessage } from "@vite-hub/agent"
import { getConsoleBlob } from "./blob.ts"
import { assertConsoleRequest, consoleRequestJSON } from "./request.ts"
import type { ImagePart } from "@vite-hub/agent"
import type { ConsoleRequestEvent } from "./request.ts"

const uploadSchema = v.object({ files: v.pipe(v.array(v.object({ url: v.string(), filename: v.optional(v.string(), "image") })), v.minLength(1), v.maxLength(10)) })
const attachmentIdsSchema = v.pipe(v.array(v.object({ id: v.pipe(v.string(), v.uuid()), name: v.pipe(v.string(), v.maxLength(255)) })), v.maxLength(10))

const prefix = "vitehub-console-attachments/"
const maximumBytes = 10 * 1024 * 1024
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])

function error(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode, statusMessage: message })
}

/** Validate the entire batch before writing; roll back this request's objects on failure. */
export async function consoleAttachmentUpload(event: ConsoleRequestEvent): Promise<ImagePart[]> {
  assertConsoleRequest(event, ["POST"])
  const body = await consoleRequestJSON(event, Math.ceil(maximumBytes * 4 / 3) + 40960)
  const parsed = v.safeParse(uploadSchema, body)
  if (!parsed.success) throw error(400, "Provide between 1 and 10 image data URLs.")
  let totalBytes = 0
  const files = parsed.output.files.map(file => {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(file.url)
    if (!match || !imageTypes.has(match[1]!)) throw error(415, "Use a PNG, JPEG, WebP, or GIF image.")
    const bytes = Buffer.from(match[2]!, "base64")
    totalBytes += bytes.length
    if (!bytes.length || totalBytes > maximumBytes) throw error(413, "Images must be non-empty and total at most 10 MiB.")
    return { bytes, mediaType: match[1]!, name: file.filename.slice(0, 255) }
  })
  let storage: ReturnType<typeof getConsoleBlob>["storage"]
  try { storage = getConsoleBlob().storage }
  catch { throw error(503, "Configure ViteHub Blob storage to send and retain Console attachments.") }
  const paths: string[] = []
  const attachments: ImagePart[] = []
  try {
    for (const file of files) {
      const id = crypto.randomUUID()
      const path = `${prefix}${id}`
      // Include the attempted write: providers may store bytes before reporting an error.
      paths.push(path)
      const [failure, stored] = await storage.put(path, file.bytes, { contentType: file.mediaType })
      if (failure) throw failure
      if (!stored.url) throw error(503, "Configure Blob serving so Console attachments can be opened after reload.")
      attachments.push({ id, mediaType: file.mediaType, name: file.name, size: file.bytes.length, type: "image", url: stored.url })
    }
    return attachments
  }
  catch (failure) {
    const cleanupErrors: Error[] = []
    for (const path of paths) {
      try {
        const [cleanupError] = await storage.del(path)
        if (cleanupError) cleanupErrors.push(cleanupError)
      }
      catch (cleanupError) {
        cleanupErrors.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)))
      }
    }
    if (cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], "Attachment upload failed and some uploaded objects could not be removed.")
    throw failure
  }
}

export async function consoleInputMessage(prompt: string, attachments: unknown): Promise<ReturnType<typeof createMessage>> {
  const parsed = v.safeParse(attachmentIdsSchema, attachments)
  if (!parsed.success) throw error(400, "Invalid attachment ID.")
  let totalBytes = 0
  const parts: ImagePart[] = []
  for (const { id, name } of new Map(parsed.output.map(part => [part.id, part])).values()) {
    const storage = getConsoleBlob().storage
    const [headError, metadata] = await storage.head(`${prefix}${id}`)
    if (headError) throw headError
    if (!metadata || !metadata.contentType || !imageTypes.has(metadata.contentType)) throw error(404, "The stored image is unavailable.")
    totalBytes += metadata.size ?? maximumBytes + 1
    if (totalBytes > maximumBytes) throw error(413, "Combined images exceed 10 MiB.")
    parts.push({
      id, type: "image", mediaType: metadata.contentType, name, size: metadata.size, url: metadata.url,
      async fetchData() {
        const [readError, data] = await storage.get(`${prefix}${id}`)
        if (readError) throw readError
        if (!data) throw error(404, "The stored image is unavailable.")
        return data
      },
    })
  }
  return createMessage({ role: "user", parts: [...(prompt ? [{ type: "text" as const, text: prompt }] : []), ...parts] })
}
