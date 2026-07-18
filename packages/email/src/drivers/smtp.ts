import nodemailer from "nodemailer"

import { EmailError, isEmailAbortError } from "../errors.ts"

import type Mail from "nodemailer/lib/mailer/index.js"
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js"
import type { EmailAddress, EmailAddressList, EmailDriver, EmailDriverResult, EmailMessage } from "../types.ts"
import type { EmailErrorCode } from "../errors.ts"

function readSmtpErrorField(error: unknown, field: "code" | "message" | "response" | "responseCode"): unknown {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return
  try {
    return (error as Record<string, unknown>)[field]
  }
  catch {
    return undefined
  }
}

function smtpAddress(address: EmailAddress): string | Mail.Address {
  return typeof address === "string"
    ? address
    : { address: address.email, ...(address.name === undefined ? {} : { name: address.name }) }
}

function smtpAddresses(addresses: EmailAddressList): Array<string | Mail.Address> {
  return (Array.isArray(addresses) ? addresses : [addresses]).map(smtpAddress)
}

function smtpErrorCode(error: unknown): EmailErrorCode {
  const code = readSmtpErrorField(error, "code")
  const message = readSmtpErrorField(error, "message")
  const response = readSmtpErrorField(error, "response")
  const responseCode = readSmtpErrorField(error, "responseCode")
  if (code === "EAUTH" || responseCode === 535) return "authentication"
  if (code === "ETIMEDOUT") return "timeout"
  if (typeof code === "string" && ["ECONNECTION", "EDNS", "ESOCKET"].includes(code)) return "network"
  if (/rate.?limit|throttl|too many/i.test(`${typeof message === "string" ? message : ""} ${typeof response === "string" ? response : ""}`)) return "rate-limit"
  return "provider"
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
          throw new EmailError("provider", "[vitehub] SMTP provider returned an invalid message id.", { driver: "smtp" })
        }
        return { id: result.messageId }
      }
      catch (error) {
        if (error instanceof EmailError) throw error
        if (isEmailAbortError(error)) throw error
        throw new EmailError(smtpErrorCode(error), "[vitehub] SMTP delivery failed.", {
          cause: error,
          driver: "smtp",
        })
      }
    },
  }
}
