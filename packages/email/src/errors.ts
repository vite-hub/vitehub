export type EmailErrorCode =
  | "authentication"
  | "invalid-message"
  | "network"
  | "not-configured"
  | "provider"
  | "rate-limit"
  | "timeout"

export interface EmailErrorOptions {
  cause?: unknown
  driver?: string
}

export class EmailError extends Error {
  readonly code: EmailErrorCode
  readonly driver?: string

  constructor(code: EmailErrorCode, message: string, options: EmailErrorOptions = {}) {
    super(message, { cause: options.cause })
    this.name = "EmailError"
    this.code = code
    this.driver = options.driver
  }
}
