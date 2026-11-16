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
  EmailEnvelope,
  EmailErrorCode,
  EmailMessage,
  EmailSendMessage,
  EmailSendResult,
  EmailTemplateMessage,
  EmailTemplateName,
  EmailTemplateRegistry,
} from "./types.ts"
