import { ViteHubError } from "@vite-hub/runtime"

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
