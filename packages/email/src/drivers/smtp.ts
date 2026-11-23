import { emailErrorDiagnostics } from "../error-diagnostics.ts"
import { emailProviderError, isEmailProviderError } from "../provider.ts"
import {
  addresses,
  applyUnsubscribe,
  formatAddress,
  requiredOption,
  validateAddresses,
  validateAttachments,
} from "./shared.ts"

import type { EmailDriver, EmailMessage, EmailProviderError, EmailProviderErrorCode } from "../types.ts"

export interface SmtpEmailDriverOptions {
  host: string
  port?: number | string
  secure?: boolean | string
  user?: string
  pass?: string
}

type Nodemailer = typeof import("nodemailer")

const unsupportedFields = [
  ["tags", "tags"],
  ["metadata", "metadata"],
  ["scheduledAt", "scheduled delivery"],
  ["idempotencyKey", "idempotency keys"],
] as const

let nodemailer: Promise<Nodemailer> | undefined

function isModuleNotFound(error: unknown): boolean {
  for (let current = error, depth = 0; typeof current === "object" && current !== null && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const { code } = current as { code?: unknown }
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true
  }
  return false
}

function loadNodemailer(): Promise<Nodemailer> {
  nodemailer ??= import("nodemailer").catch((cause: unknown) => {
    nodemailer = undefined
    if (isModuleNotFound(cause)) throw emailErrorDiagnostics.EMAIL_SMTP_NODEMAILER_MISSING({ cause })
    throw cause
  })
  return nodemailer
}

function readPort(port: SmtpEmailDriverOptions["port"], secure: boolean): number {
  if (port === undefined || port === "") return secure ? 465 : 587
  const value = Number(port)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw emailProviderError("smtp", "NOT_CONFIGURED", "port must be an integer from 1 to 65535.")
  }
  return value
}

function readSecure(secure: SmtpEmailDriverOptions["secure"], port: SmtpEmailDriverOptions["port"]): boolean {
  if (secure === undefined || secure === "") return Number(port) === 465
  if (secure === true || secure === "true") return true
  if (secure === false || secure === "false") return false
  throw emailProviderError("smtp", "NOT_CONFIGURED", "secure must be true or false.")
}

function smtpErrorCode(error: { code?: unknown, responseCode?: unknown }): EmailProviderErrorCode {
  if (error.responseCode === 421 || error.responseCode === 450 || error.responseCode === 451 || error.responseCode === 452) return "RATE_LIMIT"
  switch (error.code) {
    case "EAUTH":
    case "ENOAUTH":
      return "AUTH"
    case "ETIMEDOUT":
      return "TIMEOUT"
    case "ECONNECTION":
    case "EDNS":
    case "ESOCKET":
    case "ETLS":
      return "NETWORK"
    case "EENVELOPE":
      return "INVALID_OPTIONS"
  }
  return "PROVIDER"
}

function sendFailure(cause: unknown): EmailProviderError {
  if (isEmailProviderError(cause)) return cause
  const details = typeof cause === "object" && cause !== null ? cause as { code?: unknown, responseCode?: unknown } : {}
  const code = smtpErrorCode(details)
  const status = typeof details.responseCode === "number" ? details.responseCode : undefined
  return emailProviderError("smtp", code, "The SMTP server did not accept the message.", {
    cause,
    retryable: code === "NETWORK" || code === "TIMEOUT" || code === "RATE_LIMIT" || (status !== undefined && status >= 400 && status < 500),
    status,
  })
}

function list(value: EmailMessage["to"] | undefined): string[] | undefined {
  return value === undefined ? undefined : addresses(value).map(formatAddress)
}

function mailOptions(message: EmailMessage) {
  return {
    from: formatAddress(addresses(message.from)[0] ?? ""),
    to: list(message.to),
    cc: list(message.cc),
    bcc: list(message.bcc),
    replyTo: list(message.replyTo),
    subject: message.subject,
    text: message.text,
    html: message.html,
    headers: message.headers,
    attachments: message.attachments?.map(attachment => ({
      filename: attachment.filename,
      content: typeof attachment.content === "string" ? attachment.content : Buffer.from(attachment.content),
      contentType: attachment.contentType,
      contentDisposition: attachment.disposition,
      cid: attachment.cid,
    })),
  }
}

export default function smtpEmailDriver(options: SmtpEmailDriverOptions): EmailDriver {
  requiredOption("smtp", options?.host, "host")
  if (Boolean(options.user) !== Boolean(options.pass)) {
    throw emailProviderError("smtp", "NOT_CONFIGURED", "user and pass must be set together.")
  }
  const secure = readSecure(options.secure, options.port)
  const port = readPort(options.port, secure)
  return {
    name: "smtp",
    async initialize() {
      await loadNodemailer()
    },
    async send(message, context) {
      try {
        validateAttachments("smtp", message)
        validateAddresses("smtp", message)
        const unsupported = unsupportedFields.find(([field]) => message[field] !== undefined)
        if (unsupported) {
          return [emailProviderError("smtp", "UNSUPPORTED", `The smtp driver does not support ${unsupported[1]}.`), undefined]
        }
        if (context.signal?.aborted) {
          return [emailProviderError("smtp", "CANCELLED", "SMTP send was cancelled.", { retryable: false }), undefined]
        }
        const mail = mailOptions(applyUnsubscribe(message, "smtp"))
        const { createTransport } = await loadNodemailer()
        const transport = createTransport({
          host: options.host,
          port,
          secure,
          ...(options.user ? { auth: { user: options.user, pass: options.pass }, requireTLS: !secure } : {}),
        })
        try {
          const { accepted, rejected, messageId } = await transport.sendMail(mail)
          if (rejected?.length) {
            return [emailProviderError("smtp", "PROVIDER", "The SMTP server accepted the message for only some recipients. Do not retry the entire message.", {
              cause: { accepted, rejected, messageId },
              retryable: false,
            }), undefined]
          }
          return [undefined, { at: new Date(), driver: "smtp", id: messageId }]
        }
        finally {
          transport.close()
        }
      }
      catch (error) {
        if (emailErrorDiagnostics.EMAIL_SMTP_NODEMAILER_MISSING.is(error)) throw error
        return [sendFailure(error), undefined]
      }
    },
  }
}
