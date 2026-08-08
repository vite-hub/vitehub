import { emailError, isEmailError } from "../errors.ts"

import type {
  EmailAddress,
  EmailAddressList,
  EmailDriver,
  EmailDriverResult,
  EmailMessage,
} from "../types.ts"
import type { EmailErrorCode } from "../errors.ts"

export type ResendApiKey = string | (() => string | Promise<string>)

export interface ResendOptions {
  apiKey: ResendApiKey
}

interface ResendResponse {
  id?: unknown
  message?: unknown
  name?: unknown
  statusCode?: unknown
}

const responseHeaderNames = [
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "request-id",
  "retry-after",
  "x-resend-daily-quota",
  "x-resend-monthly-quota",
  "x-resend-request-id",
] as const

class ResendProviderError extends Error {
  readonly headers: Readonly<Record<string, string>>
  readonly statusCode: number

  constructor(
    response: ResendResponse,
    headers: Readonly<Record<string, string>>,
    statusCode: number,
  ) {
    super(
      typeof response.message === "string"
        ? response.message
        : `Resend returned HTTP ${statusCode}.`,
    )
    this.name =
      typeof response.name === "string" && response.name ? response.name : "ResendProviderError"
    this.headers = headers
    this.statusCode = typeof response.statusCode === "number" ? response.statusCode : statusCode
  }
}

function resendAddress(address: EmailAddress): string {
  return typeof address === "string"
    ? address
    : address.name
      ? `${address.name} <${address.email}>`
      : address.email
}

function resendAddresses(addresses: EmailAddressList): string[] {
  return (Array.isArray(addresses) ? addresses : [addresses]).map(resendAddress)
}

function base64(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
  let binary = ""
  for (let index = 0; index < bytes.length; index += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32_768))
  }
  return btoa(binary)
}

function resendMessage(message: EmailMessage): Record<string, unknown> {
  if (message.attachments?.some((attachment) => attachment.contentDisposition !== undefined)) {
    throw emailError(
      "EMAIL_INVALID_MESSAGE",
      "[vitehub] Resend does not support attachment contentDisposition.",
      { driver: "resend" },
    )
  }

  return {
    ...(message.attachments
      ? {
          attachments: message.attachments.map((attachment) => ({
            ...(attachment.cid === undefined ? {} : { content_id: attachment.cid }),
            content: base64(attachment.content),
            ...(attachment.contentType === undefined
              ? {}
              : { content_type: attachment.contentType }),
            filename: attachment.filename,
          })),
        }
      : {}),
    ...(message.bcc === undefined ? {} : { bcc: resendAddresses(message.bcc) }),
    ...(message.cc === undefined ? {} : { cc: resendAddresses(message.cc) }),
    from: resendAddress(message.from),
    ...(message.headers === undefined ? {} : { headers: { ...message.headers } }),
    ...(message.html === undefined ? {} : { html: message.html }),
    ...(message.replyTo === undefined ? {} : { reply_to: resendAddresses(message.replyTo) }),
    subject: message.subject,
    ...(message.text === undefined ? {} : { text: message.text }),
    to: resendAddresses(message.to),
  }
}

function resendHeaders(headers: Headers): Readonly<Record<string, string>> {
  return Object.fromEntries(
    responseHeaderNames.flatMap((name) => {
      const value = headers.get(name)
      return value === null ? [] : [[name, value]]
    }),
  )
}

function resendErrorCode(status: number, name: unknown): EmailErrorCode {
  if (
    status === 401 ||
    name === "missing_api_key" ||
    name === "restricted_api_key" ||
    name === "invalid_api_key"
  ) {
    return "EMAIL_AUTHENTICATION"
  }
  if (status === 429 || name === "rate_limit_exceeded") return "EMAIL_RATE_LIMITED"
  if (status === 408) return "EMAIL_TIMEOUT"
  return "EMAIL_PROVIDER_FAILED"
}

async function resendResponse(response: Response): Promise<ResendResponse> {
  const text = await response.text()
  if (!text) return {}
  try {
    const value = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value) ? value as ResendResponse : {}
  } catch {
    return {}
  }
}

async function resendApiKey(options: ResendOptions): Promise<string> {
  try {
    const apiKey = typeof options?.apiKey === "function" ? await options.apiKey() : options?.apiKey
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      throw emailError("EMAIL_NOT_CONFIGURED", "[vitehub] Resend requires an API key.", {
        driver: "resend",
      })
    }
    return apiKey.trim()
  } catch (error) {
    if (isEmailError(error)) throw error
    throw emailError("EMAIL_NOT_CONFIGURED", "[vitehub] Resend could not resolve its API key.", {
      cause: error,
      driver: "resend",
    })
  }
}

export function resend(options: ResendOptions): EmailDriver {
  return {
    name: "resend",
    async send(message: EmailMessage): Promise<EmailDriverResult> {
      const apiKey = await resendApiKey(options)
      const body = JSON.stringify(resendMessage(message))

      let response: Response
      let result: ResendResponse
      try {
        response = await fetch("https://api.resend.com/emails", {
          body,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "user-agent": "vitehub-email",
          },
          method: "POST",
        })
        result = await resendResponse(response)
      } catch (error) {
        throw emailError(
          "EMAIL_NETWORK",
          "[vitehub] Resend delivery could not reach the provider.",
          {
            cause: error,
            driver: "resend",
          },
        )
      }

      if (!response.ok) {
        const cause = new ResendProviderError(
          result,
          resendHeaders(response.headers),
          response.status,
        )
        throw emailError(
          resendErrorCode(response.status, result.name),
          "[vitehub] Resend delivery failed.",
          {
            cause,
            driver: "resend",
          },
        )
      }
      if (typeof result.id !== "string" || result.id.trim().length === 0) {
        throw emailError(
          "EMAIL_PROVIDER_FAILED",
          "[vitehub] Resend returned an invalid message id.",
          { driver: "resend" },
        )
      }
      return { id: result.id }
    },
  }
}
