import { emailProviderError, isEmailProviderError } from "../provider.ts"
import { addresses, applyPersonalization, bytesToBase64, formatAddress, requiredOption, stringToBase64 } from "./shared.ts"

import type { EmailAttachment, EmailDriver, EmailMessage, EmailProviderErrorCode } from "../types.ts"

export interface ResendEmailDriverOptions {
  apiKey: string
  endpoint?: string
  fetch?: typeof fetch
}

function cancelled(signal: AbortSignal | undefined, cause: unknown): boolean {
  return signal?.aborted === true || (cause instanceof DOMException && cause.name === "AbortError")
}

function validateIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const normalized = new Headers({ "Idempotency-Key": value }).get("Idempotency-Key")!
    if (normalized.length < 1 || normalized.length > 256) {
      throw emailProviderError("resend", "INVALID_OPTIONS", "idempotencyKey must contain between 1 and 256 characters.")
    }
    return normalized
  }
  catch (cause) {
    if (isEmailProviderError(cause)) throw cause
    throw emailProviderError("resend", "INVALID_OPTIONS", "idempotencyKey is not a valid HTTP header value.", { cause })
  }
}

function attachment(value: EmailAttachment): Record<string, unknown> {
  return {
    content: typeof value.content === "string" ? stringToBase64(value.content) : bytesToBase64(value.content),
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
  if (/[^\u0021-\u007E]/.test(options.apiKey)) throw emailProviderError("resend", "INVALID_OPTIONS", "apiKey contains an invalid HTTP header character.")
  const request = options.fetch ?? globalThis.fetch
  if (typeof request !== "function") throw emailProviderError("resend", "INVALID_OPTIONS", "fetch is unavailable.")
  const endpoint = options.endpoint ?? "https://api.resend.com"
  return {
    name: "resend",
    async send(message, context) {
      if (message.sandbox === true) {
        return { data: null, error: emailProviderError("resend", "UNSUPPORTED", "Resend does not support sandbox delivery.") }
      }
      if (message.raw !== undefined) {
        return { data: null, error: emailProviderError("resend", "UNSUPPORTED", "Resend does not support raw message payloads.") }
      }
      let body: string
      let idempotencyKey: string | undefined
      try {
        message = applyPersonalization("resend", message)
        idempotencyKey = validateIdempotencyKey(message.idempotencyKey)
        if (typeof message.scheduledAt === "string" && message.scheduledAt.trim() === "") {
          throw emailProviderError("resend", "INVALID_OPTIONS", "scheduledAt cannot be empty.")
        }
        body = JSON.stringify(payload(message))
      }
      catch (cause) {
        if (isEmailProviderError(cause)) return { data: null, error: cause }
        return { data: null, error: emailProviderError("resend", "INVALID_OPTIONS", "Resend payload is invalid.", { cause }) }
      }
      let response: Response
      try {
        response = await request(`${endpoint}/emails`, {
          body,
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          },
          method: "POST",
          signal: context.signal,
        })
      }
      catch (cause) {
        if (isEmailProviderError(cause)) return { data: null, error: cause }
        if (cancelled(context.signal, cause)) return { data: null, error: emailProviderError("resend", "CANCELLED", "Resend request was cancelled.", { cause, retryable: false }) }
        return { data: null, error: emailProviderError("resend", "NETWORK", "Resend request failed.", { cause, retryable: true }) }
      }
      let text: string
      try {
        text = await response.text()
      }
      catch (cause) {
        if (cancelled(context.signal, cause)) return { data: null, error: emailProviderError("resend", "CANCELLED", "Resend response was cancelled.", { cause, retryable: false }) }
        return { data: null, error: emailProviderError("resend", "NETWORK", "Resend response failed.", { cause, retryable: true }) }
      }
      let responseBody: Record<string, unknown> = {}
      try {
        const parsed: unknown = text ? JSON.parse(text) : {}
        responseBody = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
      }
      catch {}
      if (!response.ok) {
        const code: EmailProviderErrorCode = response.status === 401 || response.status === 403
          ? "AUTH"
          : response.status === 408 ? "TIMEOUT" : response.status === 429 ? "RATE_LIMIT" : response.status >= 500 ? "NETWORK" : "PROVIDER"
        return { data: null, error: emailProviderError("resend", code, typeof responseBody.message === "string" ? responseBody.message : `HTTP ${response.status}`, {
          cause: responseBody,
          retryable: code === "TIMEOUT" || code === "RATE_LIMIT" || code === "NETWORK",
          status: response.status,
        }) }
      }
      return typeof responseBody.id === "string"
        ? { data: { at: new Date(), driver: "resend", id: responseBody.id, provider: responseBody }, error: null }
        : { data: null, error: emailProviderError("resend", "PROVIDER", "Resend returned no message id.") }
    },
  }
}
