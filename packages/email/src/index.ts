export { createEmail } from "./client.ts"
export { email } from "./runtime/email.ts"
export { outboxRuntimeId as emailOutboxRuntimeId } from "#vitehub/email/definition"

export type {
  EmailAddress,
  EmailAddressList,
  EmailAttachment,
  EmailClient,
  EmailDefinition,
  EmailDriver,
  EmailDriverFactory,
  EmailDriverSource,
  EmailErrorCode,
  EmailMessage,
  EmailSendResult,
} from "./types.ts"
