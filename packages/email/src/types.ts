import type { Result } from "@vite-hub/runtime"

export type MaybePromise<T> = T | Promise<T>

export interface EmailAddressValue {
  email: string
  name?: string
}

export type EmailAddress = string | EmailAddressValue
export type EmailAddressList = EmailAddress | readonly EmailAddress[]

export interface EmailAttachment {
  filename: string
  content: string | Uint8Array
  contentType?: string
  disposition?: "attachment" | "inline"
  cid?: string
}

export interface EmailTag {
  name: string
  value: string
}

export interface EmailUnsubscribeOptions {
  url?: string
  mailto?: string
  oneClick?: boolean
}

/** The body of a message. Each message has `text`, `html`, or both. Render templates to these strings before you send. */
export type EmailBody =
  | { text: string, html?: string }
  | { html: string, text?: string }

/**
 * A message that ViteHub Email sends. `tags`, `metadata`, `scheduledAt`, and `idempotencyKey` are sent only by the
 * Resend driver. The Cloudflare Email driver rejects them.
 */
export type EmailMessage = EmailBody & {
  from: EmailAddress
  to: EmailAddressList
  cc?: EmailAddressList
  bcc?: EmailAddressList
  replyTo?: EmailAddressList
  subject: string
  headers?: Record<string, string>
  attachments?: readonly EmailAttachment[]
  tags?: readonly EmailTag[]
  idempotencyKey?: string
  scheduledAt?: string | Date
  unsubscribe?: EmailUnsubscribeOptions
  metadata?: Record<string, string>
}

/**
 * `NOT_CONFIGURED` marks invalid driver options, for example a missing API key. `INVALID_OPTIONS` marks a message
 * that the driver cannot send.
 */
export type EmailProviderErrorCode =
  | "INVALID_OPTIONS"
  | "NOT_CONFIGURED"
  | "NETWORK"
  | "AUTH"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "PROVIDER"
  | "UNSUPPORTED"
  | "CANCELLED"

export interface EmailProviderError extends Error {
  code: EmailProviderErrorCode
  driver: string
  retryable?: boolean
  status?: number
}

export interface EmailProviderResult {
  at: Date
  driver: string
  id: string
  provider?: Record<string, unknown>
}

export type EmailDriverResult =
  | { data: EmailProviderResult, error: null }
  | { data: null, error: EmailProviderError }

export interface EmailDriverContext {
  attempt: number
  driver: string
  meta: Record<string, unknown>
  signal?: AbortSignal
}

export interface EmailDriver {
  readonly name: string
  initialize?: () => MaybePromise<void>
  send: (message: EmailMessage, context: EmailDriverContext) => MaybePromise<EmailDriverResult>
}

export type EmailDriverFactory = () => MaybePromise<EmailDriver>
export type EmailDriverSource = EmailDriver | EmailDriverFactory

export interface EmailSendResult {
  driver: string
  id: string
}

export interface EmailDefinition {
  driver: EmailDriverSource
}

/** Codes that `send()` returns in the `[error, data]` tuple. Config errors throw instead. */
export type EmailErrorCode =
  | "EMAIL_AUTHENTICATION"
  | "EMAIL_INVALID_MESSAGE"
  | "EMAIL_NETWORK"
  | "EMAIL_PROVIDER_FAILED"
  | "EMAIL_RATE_LIMITED"
  | "EMAIL_TIMEOUT"

export interface EmailClient {
  /**
   * Sends one message and returns `[error, data]`. `data` tells that the provider accepted the message.
   * `EMAIL_NOT_CONFIGURED` and an invalid driver throw, because the config must change.
   */
  send: (message: EmailMessage) => Promise<Result<EmailSendResult, EmailErrorCode>>
}
