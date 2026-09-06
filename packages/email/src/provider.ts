import type { EmailProviderError, EmailProviderErrorCode } from "./types.ts"
import { emailErrorDiagnostics } from "./error-diagnostics.ts"

const emailProviderErrorCodes = new Set<EmailProviderErrorCode>([
  "AUTH",
  "CANCELLED",
  "INVALID_OPTIONS",
  "NETWORK",
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
  return Object.assign(emailErrorDiagnostics.EMAIL_R0007({ message: message, ...{ cause: options.cause } }), {
    code,
    driver,
    name: "EmailProviderError",
    retryable: options.retryable,
    status: options.status,
  })
}

export function isEmailProviderError(value: unknown): value is EmailProviderError {
  if (!(value instanceof Error)) return false
  const error = value as Partial<EmailProviderError>
  return typeof error.driver === "string"
    && error.driver.trim().length > 0
    && emailProviderErrorCodes.has(error.code as EmailProviderErrorCode)
}
