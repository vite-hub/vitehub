import { isViteHubError, ViteHubError } from "@vite-hub/runtime"

type AuthenticationProviderOperation = "get-auth-for-request" | "get-session"

interface AuthenticationProviderErrorOptions extends ErrorOptions {
  operation: AuthenticationProviderOperation
}

export function invalidAuthenticationErrorOptions(): never {
  throw new TypeError("[vitehub] Invalid authentication error options.")
}

function readAuthenticationErrorOption(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) invalidAuthenticationErrorOptions()
  try {
    if (Array.isArray(value)) invalidAuthenticationErrorOptions()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor)) invalidAuthenticationErrorOptions()
    return descriptor.value
  }
  catch {
    invalidAuthenticationErrorOptions()
  }
}

function createAuthenticationProviderError(options: AuthenticationProviderErrorOptions) {
  const cause = readAuthenticationErrorOption(options, "cause")
  const operation = readAuthenticationErrorOption(options, "operation")
  if (operation !== "get-auth-for-request" && operation !== "get-session") invalidAuthenticationErrorOptions()
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
  throw createAuthenticationProviderError({ cause, operation })
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
