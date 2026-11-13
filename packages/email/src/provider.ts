import type { EmailProviderError, EmailProviderErrorCode } from "./types.ts"

const emailProviderErrorCodes = new Set<EmailProviderErrorCode>([
  "AUTH",
  "CANCELLED",
  "INVALID_OPTIONS",
  "NETWORK",
  "NOT_CONFIGURED",
  "PROVIDER",
  "RATE_LIMIT",
  "TIMEOUT",
  "UNSUPPORTED",
])

export function emailProviderError(
  driver: string,
  code: EmailProviderErrorCode,
  message: string,
  options: { cause?: unknown, retryable?: boolean, status?: number } = {},
): EmailProviderError {
  return Object.assign(new Error(message, { cause: options.cause }), {
    code,
    driver,
    name: "EmailProviderError",
    retryable: options.retryable,
    status: options.status,
  })
}

// Check the fields that the client reads, so an Error from another realm also matches.
export function isEmailProviderError(value: unknown): value is EmailProviderError {
  if (typeof value !== "object" || value === null) return false
  const error = value as Partial<EmailProviderError>
  return typeof error.message === "string"
    && typeof error.driver === "string"
    && error.driver.trim().length > 0
    && emailProviderErrorCodes.has(error.code as EmailProviderErrorCode)
}
