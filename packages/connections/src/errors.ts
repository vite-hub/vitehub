import { ViteHubError } from "@vite-hub/runtime"

const messages = {
  approval_required: "Approval is required for this Connection Operation.",
  denied: "Connection access denied.",
  invalid: "Invalid Connection request.",
  key_mismatch: "The Connection was sealed with a different encryption key. Reconnect it.",
  missing: "The Connection is not connected.",
  needs_reconnect: "The Connection needs to be reconnected.",
  not_configured: "Connections are not configured. Enable `vitehub({ connections: true })` with a database.",
  not_found: "No Connection Definition was discovered for this name.",
  origin_not_allowed: "The request URL is not an allowed origin for this Connection.",
  provider_failed: "The Connection provider request failed.",
  unavailable: "The Connection is busy. Try again.",
} as const

export type ConnectionErrorCode = keyof typeof messages

export interface ConnectionErrorDetails {
  [key: string]: number | string | undefined
  connection?: string
  operation?: string
  status?: number
}

/** Public Connection error. Messages never include tokens or provider response bodies. */
export function connectionError(code: ConnectionErrorCode, details: ConnectionErrorDetails = {}, cause?: unknown): ViteHubError {
  const clean = Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined))
  return new ViteHubError(`CONNECTIONS_${code.toUpperCase()}`, messages[code], {
    ...(cause === undefined ? {} : { cause }),
    ...(Object.keys(clean).length ? { details: clean } : {}),
  })
}

export function isConnectionError(error: unknown, code?: ConnectionErrorCode): error is ViteHubError {
  return error instanceof ViteHubError
    && error.code.startsWith("CONNECTIONS_")
    && (code === undefined || error.code === `CONNECTIONS_${code.toUpperCase()}`)
}
