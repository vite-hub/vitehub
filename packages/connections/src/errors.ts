import { isViteHubError } from "@vite-hub/runtime"

import type { Result, ResultError } from "@vite-hub/runtime"

import { connectionsErrorDiagnostics } from "./error-diagnostics.ts"

/** Codes that a Connection client call returns in the `[error, data]` tuple. Config errors throw instead. */
export type ConnectionsErrorCode =
  | "CONNECTIONS_APPROVAL_REQUIRED"
  | "CONNECTIONS_DENIED"
  | "CONNECTIONS_INVALID_INPUT"
  | "CONNECTIONS_NEEDS_RECONNECT"
  | "CONNECTIONS_NOT_CONNECTED"
  | "CONNECTIONS_ORIGIN_NOT_ALLOWED"
  | "CONNECTIONS_PROVIDER_FAILED"
  | "CONNECTIONS_UNAVAILABLE"

/** Every code in the Connections catalog, including config and management route codes. */
export type ConnectionsCatalogCode = keyof typeof connectionsErrorDiagnostics

const returnedCodes = [
  "CONNECTIONS_APPROVAL_REQUIRED",
  "CONNECTIONS_DENIED",
  "CONNECTIONS_INVALID_INPUT",
  "CONNECTIONS_NEEDS_RECONNECT",
  "CONNECTIONS_NOT_CONNECTED",
  "CONNECTIONS_ORIGIN_NOT_ALLOWED",
  "CONNECTIONS_PROVIDER_FAILED",
  "CONNECTIONS_UNAVAILABLE",
] as const satisfies readonly ConnectionsErrorCode[]

/**
 * Returns `true` for an error from the Connections catalog. Pass `codes` to accept only some codes.
 * It reads `code`, so it also accepts an error from another copy of the package.
 */
export function isConnectionError<TCode extends ConnectionsCatalogCode = ConnectionsCatalogCode>(error: unknown, codes?: readonly TCode[]): error is ResultError<TCode> {
  if (!(error instanceof Error)) return false
  const code: unknown = Reflect.get(error, "code")
  if (typeof code !== "string" || !Object.hasOwn(connectionsErrorDiagnostics, code)) return false
  return !codes || codes.some(candidate => candidate === code)
}

/**
 * Runs one Connection client call and returns `[error, data]`.
 * A runtime Connections error is returned. Config errors and other failures throw.
 */
export async function connectionResult<TData>(run: () => Promise<TData>): Promise<Result<TData, ConnectionsErrorCode>> {
  try {
    return [undefined, await run()]
  }
  catch (error) {
    if (isConnectionError(error, returnedCodes)) return [error, undefined]
    throw error
  }
}

export function isEnvBridgeError(error: unknown, code: string): boolean {
  return isViteHubError(error) && error.code === code
}
