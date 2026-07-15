export { createEmail } from "./client.ts"
export { defineEmail } from "./definition.ts"
export { EmailError } from "./errors.ts"

export type {
  EmailAddress,
  EmailAddressList,
  EmailAttachment,
  EmailClient,
  EmailDefinition,
  EmailDriver,
  EmailDriverResult,
  EmailMessage,
  EmailSendResult,
} from "./types.ts"
export type { EmailErrorCode, EmailErrorOptions } from "./errors.ts"
