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

/** The fields of a message other than its body. */
export interface EmailEnvelope {
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
 * A message that ViteHub Email sends. `tags`, `metadata`, `scheduledAt`, and `idempotencyKey` are sent only by the
 * Resend driver. The Cloudflare Email driver rejects them.
 */
export type EmailMessage = EmailBody & EmailEnvelope

/**
 * The Markdown templates under `server/emails`, by name. `.vitehub/types/email-templates.d.ts` adds each template
 * and the `data` type that it reads.
 */
export interface EmailTemplateRegistry {}

/** The name of a template under `server/emails`, for example `welcome` or `monthly/recap`. */
export type EmailTemplateName = Extract<keyof EmailTemplateRegistry, string>

type EmailTemplateData<TName extends EmailTemplateName> = {} extends EmailTemplateRegistry[TName]
  ? { data?: EmailTemplateRegistry[TName] }
  : { data: EmailTemplateRegistry[TName] }

/** A message whose body `email.send()` renders from a template under `server/emails`. */
export type EmailTemplateMessage<TName extends EmailTemplateName = EmailTemplateName> = {
  [TTemplate in TName]: EmailEnvelope & EmailTemplateData<TTemplate> & {
    template: TTemplate
    html?: never
    text?: never
  }
}[TName]

/** What `email.send()` takes: a message with a body, or a template name and its `data`. */
export type EmailSendMessage = (EmailMessage & { template?: undefined }) | EmailTemplateMessage

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

/** What `EmailDriver.send()` returns: `[error, data]`, the same order as `email.send()`. */
export type EmailDriverResult =
  | [error: undefined, data: EmailProviderResult]
  | [error: EmailProviderError, data: undefined]

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
  | "EMAIL_TEMPLATE_RENDER_FAILED"
  | "EMAIL_TIMEOUT"

/** `createEmail()` clients take an `EmailMessage`. The `email` helper also takes an `EmailTemplateMessage`. */
export interface EmailClient<TMessage = EmailMessage> {
  /**
   * Sends one message and returns `[error, data]`. `data` tells that the provider accepted the message.
   * `EMAIL_NOT_CONFIGURED` and an invalid driver throw, because the config must change.
   */
  send: (message: TMessage) => Promise<Result<EmailSendResult, EmailErrorCode>>
}
