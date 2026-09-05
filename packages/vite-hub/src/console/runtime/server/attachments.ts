import { createMessage } from "@vite-hub/agent"
import { getConsoleBlob } from "./blob.ts"
import { assertConsoleRequest, consoleRequestJSON } from "./request.ts"
import type { ImagePart } from "@vite-hub/agent"
import type { ConsoleRequestEvent } from "./request.ts"

const prefix = "vitehub-console-attachments/"
const maximumBytes = 10 * 1024 * 1024
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])

function error(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode, statusMessage: message })
}

/** Store bytes before starting an invocation. Only durable references enter its journal. */
export async function consoleAttachmentUpload(event: ConsoleRequestEvent): Promise<ImagePart> {
  assertConsoleRequest(event, ["POST"])
  const body = await consoleRequestJSON(event, Math.ceil(maximumBytes * 4 / 3) + 4096)
  if (!body || typeof body !== "object" || !("url" in body) || typeof body.url !== "string") throw error(400, "An image data URL is required.")
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(body.url)
  if (!match || !imageTypes.has(match[1]!)) throw error(415, "Use a PNG, JPEG, WebP, or GIF image.")
  const bytes = Buffer.from(match[2]!, "base64")
  if (!bytes.length || bytes.length > maximumBytes) throw error(413, "Images must be between 1 byte and 10 MiB.")
  const id = crypto.randomUUID()
  const name = "filename" in body && typeof body.filename === "string" ? body.filename.slice(0, 255) : "image"
  let storage: ReturnType<typeof getConsoleBlob>["storage"]
  try { storage = getConsoleBlob().storage }
  catch { throw error(503, "Configure ViteHub Blob storage to send and retain Console attachments.") }
  const [failure, stored] = await storage.put(`${prefix}${id}`, bytes, { contentType: match[1], customMetadata: { name } })
  if (failure) throw failure
  if (!stored.url) throw error(503, "Configure Blob serving so Console attachments can be opened after reload.")
  return { id, mediaType: match[1]!, name, size: bytes.length, type: "image", url: stored.url }
}

export async function consoleInputMessage(prompt: string, attachments: unknown): Promise<ReturnType<typeof createMessage>> {
  if (!Array.isArray(attachments) || attachments.length > 10) throw error(400, "Attachments must contain at most ten stored image IDs.")
  let totalBytes = 0
  const parts: ImagePart[] = []
  for (const id of new Set(attachments)) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw error(400, "Invalid attachment ID.")
    const storage = getConsoleBlob().storage
    const [headError, metadata] = await storage.head(`${prefix}${id}`)
    if (headError) throw headError
    if (!metadata || !metadata.contentType || !imageTypes.has(metadata.contentType)) throw error(404, "The stored image is unavailable.")
    totalBytes += metadata.size ?? maximumBytes + 1
    if (totalBytes > maximumBytes) throw error(413, "Combined images exceed 10 MiB.")
    parts.push({
      id, type: "image", mediaType: metadata.contentType, name: metadata.customMetadata.name, size: metadata.size, url: metadata.url,
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
