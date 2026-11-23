import { getViteHubErrorShape, ViteHubError } from "@vite-hub/runtime"

export function browserSessionStateError(action: string, state: string): ViteHubError {
  return new ViteHubError("BROWSER_SESSION_STATE", `[vitehub:browser] Cannot ${action} a Browser Session while it is ${state}.`, {
    details: { action, state },
  })
}

export function browserSessionRefError(reason: "audience" | "expired" | "unknown"): ViteHubError {
  return new ViteHubError("BROWSER_SESSION_REF_INVALID", "[vitehub:browser] The Browser Session reference is invalid or no longer claimable.", {
    details: { reason },
  })
}

export function browserLiveHandoffUnsupportedError(provider: string, controller?: string): ViteHubError {
  return new ViteHubError(
    "BROWSER_LIVE_HANDOFF_UNSUPPORTED",
    `[vitehub:browser] Live handoff is not supported by ${controller ? `${provider} with ${controller}` : provider}.`,
    { details: { provider, ...(controller ? { controller } : {}) } },
  )
}

export function browserProviderError(provider: string, operation: string, options: { cause?: unknown, status?: number } = {}): ViteHubError {
  return new ViteHubError("BROWSER_PROVIDER_ERROR", `[vitehub:browser] ${provider} could not ${operation}.`, {
    cause: options.cause,
    details: { operation, provider, ...(options.status === undefined ? {} : { status: options.status }) },
  })
}

function isBrowserError(value: unknown): value is ViteHubError<`BROWSER_${string}`> {
  return getViteHubErrorShape(value)?.code.startsWith("BROWSER_") === true
}

function readQuietly<T>(read: () => T): T | undefined {
  try {
    return read()
  }
  catch {
    return undefined
  }
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return readQuietly(() => String(error.message))
  if (readQuietly(() => Object.prototype.toString.call(error)) !== "[object Error]") return undefined
  // SAFETY: The Error tag permits probing an optional message as unknown; readQuietly guards hostile access.
  const value = readQuietly(() => (error as { message?: unknown }).message)
  return value == null ? undefined : readQuietly(() => String(value))
}

export function toBrowserError(error: unknown): ViteHubError<`BROWSER_${string}`> {
  if (isBrowserError(error)) return error
  const message = errorMessage(error) ?? readQuietly(() => String(error)) ?? ""
  return new ViteHubError(
    "BROWSER_RUNTIME_ERROR",
    message || "[vitehub:browser] Browser Definition execution failed.",
    { cause: error },
  )
}
