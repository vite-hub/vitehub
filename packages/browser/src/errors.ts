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

export function browserDefinitionNotFoundError(name: string): ViteHubError {
  return new ViteHubError(
    "BROWSER_DEFINITION_NOT_FOUND",
    `[vitehub:browser] Browser Definition ${JSON.stringify(name)} was not found.`,
    { details: { name } },
  )
}

export function browserRuntimeNotConfiguredError(): ViteHubError {
  return new ViteHubError(
    "BROWSER_RUNTIME_NOT_CONFIGURED",
    "[vitehub:browser] Browser runtime is not configured. Enable Browser through the ViteHub deployment preset.",
  )
}

function isBrowserError(value: unknown): value is ViteHubError<`BROWSER_${string}`> {
  return getViteHubErrorShape(value)?.code.startsWith("BROWSER_") === true
}

export function toBrowserError(error: unknown): ViteHubError<`BROWSER_${string}`> {
  if (isBrowserError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ViteHubError(
    "BROWSER_RUNTIME_ERROR",
    message || "[vitehub:browser] Browser Definition execution failed.",
    { cause: error },
  )
}
