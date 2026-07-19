import { ViteHubError } from "@vite-hub/runtime"

export type AuthenticationProviderOperation = "get-auth-for-request" | "get-session"

export interface AuthenticationProviderErrorOptions extends ErrorOptions {
  operation: AuthenticationProviderOperation
}

export function invalidAuthenticationErrorOptions(): never {
  throw new TypeError("[vitehub] Invalid authentication error options.")
}

export function readAuthenticationErrorOption(value: unknown, key: PropertyKey): unknown {
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

export class AuthenticationProviderError extends ViteHubError<
  "AUTH_PROVIDER_OPERATION_FAILED",
  { operation: AuthenticationProviderOperation, provider: "better-auth" }
> {
  constructor(options: AuthenticationProviderErrorOptions) {
    const cause = readAuthenticationErrorOption(options, "cause")
    const operation = readAuthenticationErrorOption(options, "operation")
    if (operation !== "get-auth-for-request" && operation !== "get-session") invalidAuthenticationErrorOptions()
    super("AUTH_PROVIDER_OPERATION_FAILED", "[vitehub] Authentication provider operation failed.", {
      cause,
      details: { operation, provider: "better-auth" },
    })
    this.name = "AuthenticationProviderError"
  }
}

export function throwAuthenticationProviderError(
  cause: unknown,
  operation: AuthenticationProviderOperation,
): never {
  if (isViteHubError(cause) || isAuthenticationAbortError(cause)) throw cause
  throw new AuthenticationProviderError({ cause, operation })
}

function isViteHubError(error: unknown): error is ViteHubError {
  try {
    return error instanceof ViteHubError
  }
  catch {
    return false
  }
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
