import { getViteHubErrorShape, isViteHubError, ViteHubError } from "@vite-hub/runtime"

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

/** Normalize a ConnectionError thrown by another ViteHub package instance. */
export function normalizeConnectionError(error: unknown): ConnectionError | undefined {
  try {
    if (error instanceof ConnectionError) return error
    let shape = getViteHubErrorShape(error)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Inspect a foreign error across package and VM realms.
    if (!shape && typeof error === "object" && error !== null) {
      const read = (key: string): unknown => {
        const descriptor = Object.getOwnPropertyDescriptor(error, key)
        return descriptor && "value" in descriptor ? descriptor.value : undefined
      }
      if (read("name") === "ViteHubError") {
        const code = read("code")
        const message = read("message")
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate fields on an untrusted foreign error shape.
        if (typeof code === "string" && typeof message === "string") {
          const rawDetails = read("details")
          const details: Record<string, string | number | undefined> = {}
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate optional foreign details before enumeration.
          if (typeof rawDetails === "object" && rawDetails !== null) {
            for (const key of Reflect.ownKeys(rawDetails)) {
              // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Reflect keys may include symbols.
              if (typeof key !== "string") continue
              const descriptor = Object.getOwnPropertyDescriptor(rawDetails, key)
              const value = descriptor && "value" in descriptor ? descriptor.value : undefined
              // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Keep only serializable foreign detail values.
              if (typeof value === "string" || typeof value === "number" || value === undefined) details[key] = value
            }
          }
          const requestId = read("requestId")
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate the bounded request ID contract at the foreign boundary.
          if (requestId !== undefined && (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 256)) return undefined
          shape = { code, message, details, name: "ViteHubError", requestId }
        }
      }
    }
    if (!shape) return undefined
    // SAFETY: errorCodes is a complete mapping of every ConnectionErrorReason to its public code.
    const entry = (Object.entries(errorCodes) as [ConnectionErrorReason, ConnectionErrorCode][]).find(([, code]) => code === shape.code)
    if (!entry) return undefined
    const details: ConnectionErrorDetails = {}
    for (const [key, value] of Object.entries(shape.details ?? {})) {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Retain only values accepted by ConnectionError details.
      if (typeof value === "string" || typeof value === "number" || value === undefined) details[key] = value
    }
    return new ConnectionError(entry[0], shape.message, {
      details,
      // SAFETY: shape is validated by getViteHubErrorShape or the bounded foreign-shape checks above.
      requestId: shape.requestId,
    })
  }
  catch {
    return undefined
  }
}

export function isEnvBridgeError(error: unknown, code: string): boolean {
  return isViteHubError(error) && error.code === code
}
