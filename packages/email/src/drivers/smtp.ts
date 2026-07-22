import nodemailer from "nodemailer"

import { emailError, isEmailError } from "../errors.ts"

import type Mail from "nodemailer/lib/mailer/index.js"
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js"
import type { EmailAddress, EmailAddressList, EmailDriver, EmailDriverResult, EmailMessage } from "../types.ts"
import type { EmailErrorCode } from "../errors.ts"

interface SMTPError {
  code?: string
  message?: string
  response?: string
  responseCode?: number
}

function smtpAddress(address: EmailAddress): string | Mail.Address {
  return typeof address === "string"
    ? address
    : { address: address.email, ...(address.name === undefined ? {} : { name: address.name }) }
}

function smtpAddresses(addresses: EmailAddressList): Array<string | Mail.Address> {
  return (Array.isArray(addresses) ? addresses : [addresses]).map(smtpAddress)
}

function smtpErrorCode(error: SMTPError): EmailErrorCode {
  if (error.code === "EAUTH" || error.responseCode === 535) return "EMAIL_AUTHENTICATION"
  if (error.code === "ETIMEDOUT") return "EMAIL_TIMEOUT"
  if (["ECONNECTION", "EDNS", "ESOCKET"].includes(error.code ?? "")) return "EMAIL_NETWORK"
  if (/rate.?limit|throttl|too many/i.test(`${error.message ?? ""} ${error.response ?? ""}`)) return "EMAIL_RATE_LIMITED"
  return "EMAIL_PROVIDER_FAILED"
}

function smtpMessage(message: EmailMessage): Mail.Options {
  return {
    ...(message.attachments
      ? {
          attachments: message.attachments.map(attachment => ({
            ...(attachment.cid === undefined ? {} : { cid: attachment.cid }),
            content: typeof attachment.content === "string" ? attachment.content : Buffer.from(attachment.content),
            ...(attachment.contentDisposition === undefined ? {} : { contentDisposition: attachment.contentDisposition }),
            ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
            filename: attachment.filename,
          })),
        }
      : {}),
    ...(message.bcc === undefined ? {} : { bcc: smtpAddresses(message.bcc) }),
    ...(message.cc === undefined ? {} : { cc: smtpAddresses(message.cc) }),
    from: smtpAddress(message.from),
    ...(message.headers === undefined ? {} : { headers: { ...message.headers } }),
    ...(message.html === undefined ? {} : { html: message.html }),
    ...(message.replyTo === undefined ? {} : { replyTo: smtpAddresses(message.replyTo) }),
    subject: message.subject,
    ...(message.text === undefined ? {} : { text: message.text }),
    to: smtpAddresses(message.to),
  }
}

export function smtp(transport: string | SMTPTransport.Options): EmailDriver {
  const transporter = nodemailer.createTransport(transport)
  return {
    name: "smtp",
    async send(message: EmailMessage): Promise<EmailDriverResult> {
      try {
        const result = await transporter.sendMail(smtpMessage(message))
        if (typeof result.messageId !== "string" || result.messageId.trim().length === 0) {
          throw emailError("EMAIL_PROVIDER_FAILED", "[vitehub] SMTP provider returned an invalid message id.", { driver: "smtp" })
        }
        return { id: result.messageId }
      }
      catch (error) {
        if (isEmailError(error)) throw error
        const smtpError = error as SMTPError
        throw emailError(smtpErrorCode(smtpError), "[vitehub] SMTP delivery failed.", {
          cause: error,
          driver: "smtp",
        })
      }
    },
  }
}
