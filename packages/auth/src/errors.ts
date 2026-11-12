import { isViteHubError, ViteHubError } from "@vite-hub/runtime"
import { authErrorDiagnostics } from "./error-diagnostics.ts"

type AuthenticationProviderOperation = "get-auth-for-request" | "get-session" | "get-user"

export function invalidAuthenticationErrorOptions(): never {
  throw authErrorDiagnostics.AUTH_R0004({ message: "[vitehub] Invalid authentication error options." })
}

function createAuthenticationProviderError(cause: unknown, operation: AuthenticationProviderOperation) {
  if (operation !== "get-auth-for-request" && operation !== "get-session" && operation !== "get-user") invalidAuthenticationErrorOptions()
  return new ViteHubError("AUTH_PROVIDER_OPERATION_FAILED", "[vitehub] Authentication provider operation failed.", {
    cause,
    details: { operation, provider: "better-auth" },
  })
}

export function throwAuthenticationProviderError(
  cause: unknown,
  operation: AuthenticationProviderOperation,
): never {
  if (isViteHubError(cause) || isAuthenticationAbortError(cause)) throw cause
  throw createAuthenticationProviderError(cause, operation)
}

function isAuthenticationAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false

  try {
    return Reflect.get(error, "name") === "AbortError"
  }
  catch {
    return false
  }
}
