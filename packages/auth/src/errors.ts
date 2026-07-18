import { ViteHubError } from "@vite-hub/runtime"

export type AuthenticationProviderOperation = "get-auth-for-request" | "get-session"

export interface AuthenticationProviderErrorOptions extends ErrorOptions {
  operation: AuthenticationProviderOperation
}

export function invalidAuthenticationErrorOptions(): never {
  throw new TypeError("[vitehub] Invalid authentication error options.")
}

export function assertAuthenticationErrorOptions(value: unknown): asserts value is object {
  if (typeof value !== "object" || value === null) invalidAuthenticationErrorOptions()
  try {
    if (Array.isArray(value)) invalidAuthenticationErrorOptions()
  }
  catch {
    invalidAuthenticationErrorOptions()
  }
}

export function readAuthenticationErrorOption(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor)) invalidAuthenticationErrorOptions()
    return descriptor.value
  }
  catch {
    invalidAuthenticationErrorOptions()
  }
}

function parseAuthenticationProviderOperation(value: unknown): AuthenticationProviderOperation {
  switch (value) {
    case "get-auth-for-request":
    case "get-session":
      return value
    default:
      invalidAuthenticationErrorOptions()
  }
}

export class AuthenticationProviderError extends ViteHubError<
  "AUTH_PROVIDER_OPERATION_FAILED",
  { operation: AuthenticationProviderOperation, provider: "better-auth" }
> {
  constructor(options: AuthenticationProviderErrorOptions) {
    assertAuthenticationErrorOptions(options)
    const cause = readAuthenticationErrorOption(options, "cause")
    const operation = parseAuthenticationProviderOperation(readAuthenticationErrorOption(options, "operation"))
    super("AUTH_PROVIDER_OPERATION_FAILED", "[vitehub] Authentication provider operation failed.", {
      cause,
      details: {
        operation,
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
