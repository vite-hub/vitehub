import { getViteHubErrorShape, ViteHubError } from "@vite-hub/runtime"

export type EmailErrorCode =
  | "EMAIL_AUTHENTICATION"
  | "EMAIL_NETWORK"
  | "EMAIL_NOT_CONFIGURED"
  | "EMAIL_PROVIDER_FAILED"
  | "EMAIL_RATE_LIMITED"
  | "EMAIL_TIMEOUT"

export interface EmailErrorOptions {
  cause?: unknown
  driver?: string
}

const emailErrorCodes = new Set<EmailErrorCode>([
  "EMAIL_AUTHENTICATION",
  "EMAIL_NETWORK",
  "EMAIL_NOT_CONFIGURED",
  "EMAIL_PROVIDER_FAILED",
  "EMAIL_RATE_LIMITED",
  "EMAIL_TIMEOUT",
])

export function emailError(code: EmailErrorCode, message: string, options: EmailErrorOptions = {}): ViteHubError {
  return new ViteHubError(code, message, {
    cause: options.cause,
    details: options.driver ? { driver: options.driver } : undefined,
  })
}

export function isEmailError(value: unknown): boolean {
  const code = getViteHubErrorShape(value)?.code
  return typeof code === "string" && emailErrorCodes.has(code as EmailErrorCode)
}
