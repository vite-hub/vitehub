/**
 * The archive files of a Channel conversation. The Console, the CLI, and the Agent package read and write them the
 * same way: attachment data lives in `media/` files, and the messages point to them with `file`.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export interface ChannelArchiveMedia {
  base64: string
  mimeType?: string
  /** Path in the archive directory, such as `media/0001-meal.jpg`. */
  path: string
  size: number
}

function safeMediaName(name: unknown, mimeType: unknown, index: number): string {
  const extension = typeof mimeType === "string" ? ({ "image/gif": ".gif", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" } as Record<string, string>)[mimeType] ?? "" : ""
  const source = typeof name === "string" && name.trim() ? name.trim().split(/[\\/]/).at(-1)! : `attachment-${index}${extension}`
  const safe = source.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^\.+/, "")
  return safe || `attachment-${index}`
}

function base64Size(value: string): number {
  const clean = value.replace(/\s/g, "")
  return Math.max(0, Math.floor(clean.length * 3 / 4) - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0))
}

function materializeMessage(message: Record<string, unknown>, media: ChannelArchiveMedia[]): Record<string, unknown> {
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.map((attachment) => {
        if (!isRecord(attachment) || typeof attachment.data !== "string") return attachment
        const { data, ...rest } = attachment
        const path = `media/${String(media.length + 1).padStart(4, "0")}-${safeMediaName(rest.name, rest.mimeType, media.length + 1)}`
        media.push({ base64: data, ...(typeof rest.mimeType === "string" ? { mimeType: rest.mimeType } : {}), path, size: base64Size(data) })
        return { ...rest, file: path }
      })
    : undefined
  // A quoted message carries attachments of its own.
  const replyTo = isRecord(message.replyTo) ? materializeMessage(message.replyTo, media) : undefined
  return { ...message, ...(attachments ? { attachments } : {}), ...(replyTo ? { replyTo } : {}) }
}

/**
 * Move the attachment data of an archive into files, as `channels history` writes them: each attachment keeps its
 * fields except `data`, and gains `file: "media/<number>-<name>"`. A quoted message (`replyTo`) is searched too, at any depth.
 */
export function materializeChannelArchive<T extends { messages: readonly Record<string, unknown>[] }>(archive: T): { archive: T, media: ChannelArchiveMedia[] } {
  const media: ChannelArchiveMedia[] = []
  const messages = archive.messages.map(message => materializeMessage(message, media))
  return { archive: { ...archive, messages }, media }
}

/** Put the data of `media` files back into the attachments of an archive, at any depth. The reverse of `materializeChannelArchive`. */
export function inlineChannelArchiveMedia<T extends { messages: readonly Record<string, unknown>[] }>(archive: T, media: readonly { base64: string, path: string }[]): T {
  const files = new Map(media.map(file => [file.path, file.base64]))
  const inline = (message: Record<string, unknown>): Record<string, unknown> => ({
    ...message,
    ...(Array.isArray(message.attachments)
      ? {
          attachments: message.attachments.map((attachment) => {
            if (!isRecord(attachment) || typeof attachment.file !== "string") return attachment
            const data = files.get(attachment.file)
            if (data === undefined) return attachment
            const { file: _file, ...rest } = attachment
            return { ...rest, data }
          }),
        }
      : {}),
    ...(isRecord(message.replyTo) ? { replyTo: inline(message.replyTo) } : {}),
  })
  return { ...archive, messages: archive.messages.map(inline) }
}

