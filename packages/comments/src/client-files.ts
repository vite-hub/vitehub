import type { CommentAttachment, CommentFiles, CommentSubject, CommentUploadInput } from "./client-types.ts"

export const outboxAccountHeader = "x-vitehub-comments-outbox-account"

export class CommentPreparationError extends Error {
  constructor(cause: unknown) {
    super("The comment write did not start.", { cause })
  }
}

/** The file as Base64, the form that `comments.upload` takes. */
export async function base64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

/** A `File` keeps its name. A plain `Blob` gets `file` and the extension of its media type, such as `file.png`. */
function fileName(file: Blob): string {
  if (file instanceof File && file.name) return file.name
  const extension = /^[a-z]+\/([a-z0-9]+)/i.exec(file.type)?.[1]
  return extension ? `file.${extension}` : "file"
}

/** Stores each file with `upload`, in order, and returns the keys for `attachments`. */
export async function uploadFiles(
  files: readonly Blob[],
  subject: CommentSubject | undefined,
  upload: (input: CommentUploadInput) => Promise<CommentAttachment>,
  uploaded?: (key: string) => Promise<void>,
): Promise<string[]> {
  const keys: string[] = []
  for (const file of files) {
    const stored = await upload({ name: fileName(file), type: file.type || "application/octet-stream", data: await base64(file), ...(subject ? { subject } : {}) })
    await uploaded?.(stored.key)
    keys.push(stored.key)
  }
  return keys
}

export async function withCommentFiles<T extends { attachments?: string[] }>(
  input: T,
  { files, outbox }: CommentFiles,
  subject: CommentSubject | undefined,
  upload: (input: CommentUploadInput) => Promise<CommentAttachment>,
): Promise<T> {
  if (!files?.length) return input
  try {
    return { ...input, attachments: [...(input.attachments ?? []), ...await uploadFiles(files, subject, upload, outbox?.uploaded)] }
  }
  catch (cause) {
    if (!outbox) throw cause
    throw new CommentPreparationError(cause)
  }
}

/** The `Retry-After` of an answer in milliseconds: seconds, or an HTTP date. */
export function retryAfterOf(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get("retry-after")?.trim()
  if (!value) return undefined
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}
