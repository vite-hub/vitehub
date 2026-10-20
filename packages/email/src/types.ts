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

export interface EmailPersonalization {
  to: EmailAddressList
  cc?: EmailAddressList
  bcc?: EmailAddressList
  subject?: string
  variables?: Record<string, unknown>
  sendAt?: Date | string
  customArgs?: Record<string, string>
}

export interface EmailDsnOptions {
  notify?: readonly ("SUCCESS" | "FAILURE" | "DELAY" | "NEVER")[]
  ret?: "FULL" | "HDRS"
  envid?: string
  orcpt?: string
}

export interface EmailTemplateOptions {
  id?: string
  alias?: string
  variables?: Record<string, unknown>
  locale?: string
}

export interface EmailTrackingOptions {
  opens?: boolean
  clicks?: boolean
  unsubscribes?: boolean
}

export interface EmailUnsubscribeOptions {
  url?: string
  mailto?: string
  oneClick?: boolean
}

export interface EmailMessage {
  from: EmailAddress
  to: EmailAddressList
  cc?: EmailAddressList
  bcc?: EmailAddressList
  replyTo?: EmailAddressList
  subject: string
  preheader?: string
  text?: string
  html?: string
  headers?: Record<string, string>
  attachments?: readonly EmailAttachment[]
  tags?: readonly EmailTag[]
  idempotencyKey?: string
  scheduledAt?: string | Date
  unsubscribe?: EmailUnsubscribeOptions
  template?: EmailTemplateOptions
  tracking?: EmailTrackingOptions
  sandbox?: boolean
  metadata?: Record<string, string>
  personalizations?: readonly EmailPersonalization[]
  amp?: string
  dsn?: EmailDsnOptions
  raw?: string | Uint8Array
  react?: unknown
  jsx?: unknown
  mjml?: string
  handlebars?: string
  handlebarsVars?: Record<string, unknown>
  liquid?: string
  liquidVars?: Record<string, unknown>
  locale?: string
  stream?: string
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
  stream?: string
}

export type EmailDriverResult =
  | { data: EmailProviderResult, error: null }
  | { data: null, error: EmailProviderError }

export interface EmailDriverContext {
  attempt: number
  driver: string
  meta: Record<string, unknown>
  signal?: AbortSignal
  stream?: string
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
