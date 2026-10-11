import type { EmailProviderError, EmailProviderErrorCode } from "./types.ts"
import { emailErrorDiagnostics } from "./error-diagnostics.ts"

function isError(value: unknown): value is Error {
  if (typeof value !== "object" || value === null) return false
  try {
    const nativeIsError = Reflect.get(Error, "isError")
    if (typeof nativeIsError === "function") return nativeIsError(value) === true
    return !(Symbol.toStringTag in value) && Object.prototype.toString.call(value) === "[object Error]"
  }
  catch {
    return false
  }
}

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
  return Object.assign(emailErrorDiagnostics.EMAIL_R0007({ message, cause: options.cause }), {
    code,
    driver,
    name: "EmailProviderError",
    retryable: options.retryable,
    status: options.status,
  })
}

export function isEmailProviderError(value: unknown): value is EmailProviderError {
  if (!isError(value)) return false
  const error = value as Partial<EmailProviderError>
  return typeof error.driver === "string"
    && error.driver.trim().length > 0
    && emailProviderErrorCodes.has(error.code as EmailProviderErrorCode)
}
