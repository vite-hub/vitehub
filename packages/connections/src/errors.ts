import { isViteHubError, ViteHubError } from "@vite-hub/runtime"

export type ConnectionErrorReason = "approval_required" | "denied" | "execution_unknown" | "invalid" | "provider" | "reauth_required"
export type ConnectionErrorCode = `CONNECTION_${Uppercase<ConnectionErrorReason>}`

export interface ConnectionErrorDetails {
  [key: string]: string | number | undefined
  action?: string
  connection?: string
  /** HTTP status from the provider. Set only for `CONNECTION_PROVIDER`. */
  status?: number
}

const errorCodes = {
  approval_required: "CONNECTION_APPROVAL_REQUIRED",
  denied: "CONNECTION_DENIED",
  execution_unknown: "CONNECTION_EXECUTION_UNKNOWN",
  invalid: "CONNECTION_INVALID",
  provider: "CONNECTION_PROVIDER",
  reauth_required: "CONNECTION_REAUTH_REQUIRED",
} as const satisfies Record<ConnectionErrorReason, ConnectionErrorCode>

/** A Connection failure. The message and details never contain token values. */
export class ConnectionError extends ViteHubError<ConnectionErrorCode, ConnectionErrorDetails> {
  readonly reason: ConnectionErrorReason

  constructor(reason: ConnectionErrorReason, message: string, options: { details?: ConnectionErrorDetails, requestId?: string } = {}) {
    super(errorCodes[reason], message, options)
    this.reason = reason
  }

  /** HTTP status from the provider, when the provider rejected the call. */
  get status(): number | undefined {
    return this.details?.status
  }
}

export function isConnectionError(error: unknown): error is ConnectionError {
  return error instanceof ConnectionError
}

export function isEnvBridgeError(error: unknown, code: string): boolean {
  return isViteHubError(error) && error.code === code
}
