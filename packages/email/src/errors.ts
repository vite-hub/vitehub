import { ViteHubError } from "@vite-hub/runtime"

import type { ViteHubErrorDetails, ViteHubErrorOptions } from "@vite-hub/runtime"

export type EmailErrorCode =
  | "authentication"
  | "invalid-message"
  | "network"
  | "not-configured"
  | "provider"
  | "rate-limit"
  | "timeout"

export type EmailErrorDetails = ViteHubErrorDetails & {
  readonly driver?: string
}

export interface EmailErrorMetadata extends ViteHubErrorOptions<EmailErrorDetails> {
  driver?: string
}

export interface EmailErrorOptions extends EmailErrorMetadata {
  code: EmailErrorCode
  message: string
}

export function isEmailAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false

  try {
    return "name" in error && error.name === "AbortError"
  }
  catch {
    return false
  }
}

function safeEmailDriver(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
    ? value
    : undefined
}

export class EmailError extends ViteHubError<EmailErrorCode, EmailErrorDetails> {
  readonly driver?: string

  constructor(options: EmailErrorOptions)
  constructor(code: EmailErrorCode, message: string, metadata?: EmailErrorMetadata)
  constructor(
    codeOrOptions: EmailErrorCode | EmailErrorOptions,
    message?: string,
    metadata: EmailErrorMetadata = {},
  ) {
    const options = typeof codeOrOptions === "string" ? metadata : codeOrOptions
    const code = typeof codeOrOptions === "string" ? codeOrOptions : codeOrOptions.code
    const resolvedMessage = typeof codeOrOptions === "string" ? message! : codeOrOptions.message
    const inputDetails = typeof options.details === "object" && options.details !== null && !Array.isArray(options.details)
      ? options.details
      : undefined
    const { driver: detailsDriver, ...otherDetails } = inputDetails ?? {}
    const driver = safeEmailDriver(options.driver ?? detailsDriver)
    const details = Object.keys(otherDetails).length === 0 && driver === undefined
      ? undefined
      : { ...otherDetails, ...(driver === undefined ? {} : { driver }) }

    super(code, resolvedMessage, {
      cause: options.cause,
      details,
      requestId: options.requestId,
      retryable: options.retryable,
    })
    this.name = "EmailError"
    this.driver = driver
  }
}
