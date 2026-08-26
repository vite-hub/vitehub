import { emailProviderError, isEmailProviderError } from "../provider.ts"
import { addresses, bytesToBase64, formatAddress, requiredOption } from "./shared.ts"

import type { EmailAttachment, EmailDriver, EmailMessage, EmailProviderErrorCode } from "../types.ts"

export interface ResendEmailDriverOptions {
  apiKey: string
  endpoint?: string
  fetch?: typeof fetch
}

function attachment(value: EmailAttachment): Record<string, unknown> {
  return {
    content: typeof value.content === "string" ? value.content : bytesToBase64(value.content),
    ...(value.cid ? { content_id: value.cid } : {}),
    ...(value.contentType ? { content_type: value.contentType } : {}),
    ...(value.disposition ? { disposition: value.disposition } : {}),
    filename: value.filename,
  }
}

function payload(message: EmailMessage): Record<string, unknown> {
  const from = addresses(message.from)[0]
  if (!from) throw emailProviderError("resend", "INVALID_OPTIONS", "from is required.")
  return {
    ...(message.attachments?.length ? { attachments: message.attachments.map(attachment) } : {}),
    ...(message.bcc ? { bcc: addresses(message.bcc).map(formatAddress) } : {}),
    ...(message.cc ? { cc: addresses(message.cc).map(formatAddress) } : {}),
    from: formatAddress(from),
    ...(message.headers ? { headers: {
      ...message.headers,
      ...Object.fromEntries(Object.entries(message.metadata ?? {}).map(([key, value]) => [`X-Metadata-${key}`, value])),
    } } : message.metadata ? { headers: Object.fromEntries(Object.entries(message.metadata).map(([key, value]) => [`X-Metadata-${key}`, value])) } : {}),
    ...(message.html ? { html: message.html } : {}),
    ...(message.replyTo ? { reply_to: addresses(message.replyTo).map(formatAddress) } : {}),
    ...(message.scheduledAt ? { scheduled_at: message.scheduledAt instanceof Date ? message.scheduledAt.toISOString() : message.scheduledAt } : {}),
    subject: message.subject,
    ...(message.tags ? { tags: message.tags } : {}),
    ...(message.text ? { text: message.text } : {}),
    to: addresses(message.to).map(formatAddress),
  }
}

export default function resendEmailDriver(options: ResendEmailDriverOptions): EmailDriver {
  requiredOption("resend", options?.apiKey, "apiKey")
  if (!options.apiKey.startsWith("re_")) throw emailProviderError("resend", "INVALID_OPTIONS", "apiKey must start with 're_'.")
  const request = options.fetch ?? globalThis.fetch
  if (typeof request !== "function") throw emailProviderError("resend", "INVALID_OPTIONS", "fetch is unavailable.")
  const endpoint = options.endpoint ?? "https://api.resend.com"
  return {
    name: "resend",
    async send(message) {
      let response: Response
      try {
        response = await request(`${endpoint}/emails`, {
          body: JSON.stringify(payload(message)),
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
            ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
          },
          method: "POST",
        })
      }
      catch (cause) {
        if (isEmailProviderError(cause)) return { data: null, error: cause }
        return { data: null, error: emailProviderError("resend", "NETWORK", "Resend request failed.", { cause, retryable: true }) }
      }
      const text = await response.text()
      let body: Record<string, unknown> = {}
      try { body = text ? JSON.parse(text) as Record<string, unknown> : {} }
      catch {}
      if (!response.ok) {
        const code: EmailProviderErrorCode = response.status === 401 || response.status === 403
          ? "AUTH"
          : response.status === 429 ? "RATE_LIMIT" : response.status >= 500 ? "NETWORK" : "PROVIDER"
        return { data: null, error: emailProviderError("resend", code, typeof body.message === "string" ? body.message : `HTTP ${response.status}`, {
          cause: body,
          retryable: code === "RATE_LIMIT" || code === "NETWORK",
          status: response.status,
        }) }
      }
      return typeof body.id === "string"
        ? { data: { at: new Date(), driver: "resend", id: body.id, provider: body }, error: null }
        : { data: null, error: emailProviderError("resend", "PROVIDER", "Resend returned no message id.") }
    },
  }
}
