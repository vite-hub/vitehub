import type { EmailProviderError, EmailProviderErrorCode } from "./types.ts"
import { emailErrorDiagnostics } from "./error-diagnostics.ts"

function isError(value: unknown): value is Error {
  if (typeof value !== "object" || value === null) return false
  try {
    const nativeIsError = Reflect.get(Error, "isError")
    if (typeof nativeIsError === "function") return nativeIsError(value) === true
    // `structuredClone` performs the platform's internal Error brand check. A
    // prototype impostor is cloned as an ordinary object, while genuine Errors
    // (including those from another realm) are cloned as native Errors.
    const clone = Reflect.get(globalThis, "structuredClone")
    if (typeof clone === "function") {
      try {
        return clone(value) instanceof Error
      }
      catch {}
    }
    // Native Error instances materialize their stack as an own property. An
    // object that merely inherits Error.prototype has no native error slots.
    if (!Object.prototype.hasOwnProperty.call(value, "stack")) return false
    const seen = new Set<object>()
    let prototype = Object.getPrototypeOf(value)
    for (let depth = 0; depth < 64 && prototype !== null && prototype !== Object.prototype; depth++) {
      if (seen.has(prototype)) return false
      seen.add(prototype)
      const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
      if (Object.prototype.toString.call(constructor) === "[object Function]" && constructor.prototype === prototype
        && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Error)) {
        return true
      }
      prototype = Object.getPrototypeOf(prototype)
    }
    return false
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
