export type EmailAddress = string | {
  email: string
  name?: string
}

export type EmailAddressList = EmailAddress | readonly EmailAddress[]

export interface EmailAttachment {
  cid?: string
  content: string | Uint8Array
  contentDisposition?: "attachment" | "inline"
  contentType?: string
  filename: string
}

interface EmailMessageFields {
  attachments?: readonly EmailAttachment[]
  bcc?: EmailAddressList
  cc?: EmailAddressList
  from: EmailAddress
  headers?: Readonly<Record<string, string>>
  replyTo?: EmailAddressList
  subject: string
  to: EmailAddressList
}

export type EmailMessage = EmailMessageFields & (
  | { html: string; text?: string }
  | { html?: string; text: string }
)

export interface EmailDriverResult {
  id: string
}

export interface EmailSendResult extends EmailDriverResult {
  driver: string
}

export interface EmailDriver {
  readonly name: string
  send: (message: EmailMessage) => Promise<EmailDriverResult>
}

export interface EmailDefinition {
  driver: EmailDriver
}

export interface EmailClientOptions {
  driver: EmailDriver
}

export interface EmailClient {
  send: (message: EmailMessage) => Promise<EmailSendResult>
}
