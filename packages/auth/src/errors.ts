import { ViteHubError } from "@vite-hub/runtime"

export type AuthenticationProviderOperation = "get-auth-for-request" | "get-session"

export interface AuthenticationProviderErrorOptions extends ErrorOptions {
  operation: AuthenticationProviderOperation
}

function parseAuthenticationProviderOperation(value: unknown): AuthenticationProviderOperation {
  switch (value) {
    case "get-auth-for-request":
    case "get-session":
      return value
    default:
      throw new TypeError("[vitehub] Invalid authentication provider operation.")
  }
}

export class AuthenticationProviderError extends ViteHubError<
  "AUTH_PROVIDER_OPERATION_FAILED",
  { operation: AuthenticationProviderOperation, provider: "better-auth" }
> {
  constructor(options: AuthenticationProviderErrorOptions) {
    super("AUTH_PROVIDER_OPERATION_FAILED", "[vitehub] Authentication provider operation failed.", {
      cause: options.cause,
      details: {
        operation: parseAuthenticationProviderOperation(options.operation),
        provider: "better-auth",
      },
    })
    this.name = "AuthenticationProviderError"
  }
}

export function throwAuthenticationProviderError(
  cause: unknown,
  operation: AuthenticationProviderOperation,
): never {
  if (
    cause instanceof ViteHubError
    || isAuthenticationAbortError(cause)
  ) {
    throw cause
  }
  throw new AuthenticationProviderError({ cause, operation })
}

function isAuthenticationAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false

  try {
    return "name" in error && error.name === "AbortError"
  }
  catch {
    return false
  }
}
