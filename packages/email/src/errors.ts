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
    const driver = options.driver ?? options.details?.driver
    const details = driver === undefined ? options.details : { ...options.details, driver }

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
