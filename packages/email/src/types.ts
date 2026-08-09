import type { Attachment, EmailAddressInput, EmailDriver, EmailMessage, MaybePromise } from "unemail"

export type { EmailDriver, EmailMessage }
export type { EmailAddressInput as EmailAddressList } from "unemail"
export type EmailAddress = Exclude<EmailAddressInput, readonly unknown[]>
export type EmailAttachment = Attachment

export type EmailDriverFactory = () => MaybePromise<EmailDriver>
export type EmailDriverSource = EmailDriver | EmailDriverFactory

export interface EmailSendResult {
  driver: string
  id: string
}

export interface EmailDefinition {
  driver: EmailDriverSource
}

export interface EmailClient {
  send: (message: EmailMessage) => Promise<EmailSendResult>
}
