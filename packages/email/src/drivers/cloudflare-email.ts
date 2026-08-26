import { emailProviderError, isEmailProviderError } from "../provider.ts"
import { addresses, addressValue, bytesToBase64, formatAddress, requiredOption, stringToBase64 } from "./shared.ts"

import type { EmailAttachment, EmailDriver, EmailMessage } from "../types.ts"

export interface CloudflareEmailBinding {
  send: (message: unknown) => Promise<void> | void
}

export type CloudflareEmailMessageConstructor = new (from: string, to: string, raw: string) => unknown

export interface CloudflareEmailDriverOptions {
  binding: CloudflareEmailBinding
  EmailMessage?: CloudflareEmailMessageConstructor
}

function safeHeader(value: string): string {
  if (/\r|\n/.test(value)) throw emailProviderError("cloudflare-email", "INVALID_OPTIONS", "Email headers cannot contain line breaks.")
  return value
}

function headerLine(name: string, value: string): string {
  const line = `${safeHeader(name)}: ${safeHeader(value)}`
  if (new TextEncoder().encode(line).length > 998) {
    throw emailProviderError("cloudflare-email", "INVALID_OPTIONS", `Cloudflare Email cannot encode an overlong ${name} header.`)
  }
  return line
}

function quotedParameter(value: string): string {
  return safeHeader(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

function foldBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? ""
}

function encodedBody(value: string): string[] {
  const canonical = value.replace(/\r\n|\r|\n/g, "\r\n")
  return ["Content-Transfer-Encoding: base64", "", foldBase64(stringToBase64(canonical))]
}

function attachmentPart(boundary: string, value: EmailAttachment): string {
  const content = foldBase64(typeof value.content === "string" ? stringToBase64(value.content) : bytesToBase64(value.content))
  const filename = quotedParameter(value.filename)
  return [
    `--${boundary}`,
    `Content-Type: ${safeHeader(value.contentType ?? "application/octet-stream")}; name="${filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${value.disposition ?? "attachment"}; filename="${filename}"`,
    ...(value.cid ? [`Content-ID: <${safeHeader(value.cid)}>`] : []),
    "",
    content,
  ].join("\r\n")
}

function bodyPart(message: EmailMessage): { contentType: string, lines: string[] } {
  if (message.html !== undefined && message.text !== undefined) {
    const boundary = `vitehub-alternative-${crypto.randomUUID()}`
    return {
      contentType: `multipart/alternative; boundary="${boundary}"`,
      lines: [
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        ...encodedBody(message.text),
        `--${boundary}`,
        "Content-Type: text/html; charset=utf-8",
        ...encodedBody(message.html),
        `--${boundary}--`,
      ],
    }
  }
  return {
    contentType: message.html !== undefined ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    lines: encodedBody(message.html ?? message.text ?? ""),
  }
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  const normalizedName = name.toLowerCase()
  return Object.entries(headers ?? {}).find(([header]) => header.toLowerCase() === normalizedName)?.[1]
}

function rawMessage(message: EmailMessage, id: string): string {
  const boundary = `vitehub-${crypto.randomUUID()}`
  const body = bodyPart(message)
  const headers = [
    headerLine("From", formatAddress(addresses(message.from)[0]!)),
    headerLine("To", addresses(message.to).map(formatAddress).join(", ")),
    ...(message.cc ? [headerLine("Cc", addresses(message.cc).map(formatAddress).join(", "))] : []),
    ...(message.replyTo ? [headerLine("Reply-To", addresses(message.replyTo).map(formatAddress).join(", "))] : []),
    headerLine("Subject", message.subject),
    headerLine("Message-ID", id),
    "MIME-Version: 1.0",
    ...Object.entries(message.headers ?? {}).filter(([name]) => name.toLowerCase() !== "message-id").map(([name, value]) => headerLine(name, value)),
  ]
  if (!message.attachments?.length) return [...headers, `Content-Type: ${body.contentType}`, ...body.lines].join("\r\n")
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: ${body.contentType}`,
    ...body.lines,
    ...message.attachments.map(value => attachmentPart(boundary, value)),
    `--${boundary}--`,
    "",
  ].join("\r\n")
}

const transportOwnedHeaders = new Set(["from", "to", "cc", "bcc", "reply-to", "subject", "mime-version", "content-type", "content-transfer-encoding"])

function rejectTransportOwnedHeaders(headers: Record<string, string> | undefined): void {
  const header = Object.keys(headers ?? {}).find(name => transportOwnedHeaders.has(name.toLowerCase()))
  if (header) throw emailProviderError("cloudflare-email", "INVALID_OPTIONS", `Cloudflare Email owns the ${header} header.`)
}

export default function cloudflareEmailDriver(options: CloudflareEmailDriverOptions): EmailDriver {
  requiredOption("cloudflare-email", options?.binding, "binding")
  const Constructor = options.EmailMessage ?? (globalThis as typeof globalThis & { EmailMessage?: CloudflareEmailMessageConstructor }).EmailMessage
  if (!Constructor) throw emailProviderError("cloudflare-email", "INVALID_OPTIONS", "EmailMessage constructor is unavailable.")
  return {
    name: "cloudflare-email",
    async send(message, context) {
      try {
        if (context.signal?.aborted) {
          return { data: null, error: emailProviderError("cloudflare-email", "CANCELLED", "Cloudflare Email send was cancelled.", { retryable: false }) }
        }
        rejectTransportOwnedHeaders(message.headers)
        if (message.scheduledAt !== undefined) {
          return { data: null, error: emailProviderError("cloudflare-email", "UNSUPPORTED", "Cloudflare Email does not support scheduled delivery.") }
        }
        if (message.raw !== undefined) {
          return { data: null, error: emailProviderError("cloudflare-email", "UNSUPPORTED", "Cloudflare Email does not support raw message payloads.") }
        }
        if (message.idempotencyKey !== undefined) {
          return { data: null, error: emailProviderError("cloudflare-email", "UNSUPPORTED", "Cloudflare Email does not support idempotency keys.") }
        }
        const from = addresses(message.from)[0]
        const recipients = [
          ...addresses(message.to),
          ...(message.cc ? addresses(message.cc) : []),
          ...(message.bcc ? addresses(message.bcc) : []),
        ]
        if (!from || recipients.length === 0) return { data: null, error: emailProviderError("cloudflare-email", "INVALID_OPTIONS", "from and to are required.") }
        if (recipients.length > 1) return { data: null, error: emailProviderError("cloudflare-email", "UNSUPPORTED", "Cloudflare Email supports exactly one envelope recipient per message.") }
        const customId = headerValue(message.headers, "message-id")
        if (customId !== undefined && customId.trim() === "") {
          return { data: null, error: emailProviderError("cloudflare-email", "INVALID_OPTIONS", "Message-ID cannot be empty.") }
        }
        const id = customId ?? `<${crypto.randomUUID()}@vitehub.email>`
        const raw = rawMessage(message, id)
        await options.binding.send(new Constructor(addressValue(from).email, addressValue(recipients[0]!).email, raw))
        return { data: { at: new Date(), driver: "cloudflare-email", id }, error: null }
      }
      catch (cause) {
        if (isEmailProviderError(cause)) return { data: null, error: cause }
        return { data: null, error: emailProviderError("cloudflare-email", "PROVIDER", "Cloudflare Email send failed.", { cause }) }
      }
    },
  }
}
