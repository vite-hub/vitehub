import { assertEmailDriver } from "./definition.ts"
import { emailError, isEmailError } from "./errors.ts"

import type {
  EmailAddress,
  EmailAddressList,
  EmailAttachment,
  EmailClient,
  EmailDefinition,
  EmailDriverResult,
  EmailMessage,
  EmailSendResult,
} from "./types.ts"

function validAddress(value: unknown): value is EmailAddress {
  if (typeof value === "string") return value.trim().length > 0
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const address = value as Record<string, unknown>
  return typeof address.email === "string"
    && address.email.trim().length > 0
    && (address.name === undefined || typeof address.name === "string")
}

function validAddressList(value: unknown): value is EmailAddressList {
  const addresses = Array.isArray(value) ? value : [value]
  return addresses.length > 0 && Array.from(addresses).every(validAddress)
}

function validAttachment(value: unknown): value is EmailAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const attachment = value as Record<string, unknown>
  return typeof attachment.filename === "string"
    && attachment.filename.trim().length > 0
    && (typeof attachment.content === "string" || attachment.content instanceof Uint8Array)
    && (attachment.cid === undefined || typeof attachment.cid === "string")
    && (attachment.contentDisposition === undefined || attachment.contentDisposition === "attachment" || attachment.contentDisposition === "inline")
    && (attachment.contentType === undefined || typeof attachment.contentType === "string")
}

function validHeaders(value: unknown): value is Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(header => typeof header === "string")
}

function assertEmailMessage(message: EmailMessage, driver: string): void {
  if (!message || typeof message !== "object") {
    throw emailError("EMAIL_INVALID_MESSAGE", "[vitehub] Email message must be an object.", { driver })
  }
  const input = message as unknown as Record<string, unknown>
  if (!validAddress(input.from)) {
    throw emailError("EMAIL_INVALID_MESSAGE", "[vitehub] Email message from must contain an address.", { driver })
  }
  if (!validAddressList(input.to)) {
    throw emailError("EMAIL_INVALID_MESSAGE", "[vitehub] Email message to must contain at least one address.", { driver })
  }
  if (typeof input.subject !== "string" || input.subject.trim().length === 0) {
    throw emailError("EMAIL_INVALID_MESSAGE", "[vitehub] Email message subject must be a non-empty string.", { driver })
  }
  if (input.html !== undefined && typeof input.html !== "string") {
    throw emailError("EMAIL_INVALID_MESSAGE", "[vitehub] Email message html must be a string.", { driver })
  }
  if (input.text !== undefined && typeof input.text !== "string") {
    throw emailError("EMAIL_INVALID_MESSAGE", "[vitehub] Email message text must be a string.", { driver })
  }
  if (
    (typeof input.html !== "string" || input.html.trim().length === 0)
    && (typeof input.text !== "string" || input.text.trim().length === 0)
  ) {
    throw emailError("EMAIL_INVALID_MESSAGE", "[vitehub] Email message must include non-empty html or text.", { driver })
  }
  for (const [field, value] of [["cc", input.cc], ["bcc", input.bcc], ["replyTo", input.replyTo]] as const) {
    if (value !== undefined && !validAddressList(value)) {
      throw emailError("EMAIL_INVALID_MESSAGE", `[vitehub] Email message ${field} must contain at least one address.`, { driver })
    }
  }
  if (input.headers !== undefined && !validHeaders(input.headers)) {
    throw emailError("EMAIL_INVALID_MESSAGE", "[vitehub] Email message headers must contain string values.", { driver })
  }
  if (input.attachments !== undefined && (!Array.isArray(input.attachments) || !Array.from(input.attachments).every(validAttachment))) {
    throw emailError("EMAIL_INVALID_MESSAGE", "[vitehub] Email attachments require a filename and in-memory content.", { driver })
  }
}

function validDriverResult(result: EmailDriverResult): boolean {
  return Boolean(result) && typeof result.id === "string" && result.id.trim().length > 0
}

export function createEmail(options: EmailDefinition): EmailClient {
  assertEmailDriver(options?.driver)
  const driver = options.driver

  return {
    async send(message: EmailMessage): Promise<EmailSendResult> {
      assertEmailMessage(message, driver.name)
      try {
        const result = await driver.send(message)
        if (!validDriverResult(result)) {
          throw emailError("EMAIL_PROVIDER_FAILED", `[vitehub] Email driver ${driver.name} returned an invalid message id.`, { driver: driver.name })
        }
        return { driver: driver.name, id: result.id }
      }
      catch (error) {
        if (isEmailError(error)) throw error
        throw emailError("EMAIL_PROVIDER_FAILED", `[vitehub] Email delivery failed through ${driver.name}.`, {
          cause: error,
          driver: driver.name,
        })
      }
    },
  }
}
