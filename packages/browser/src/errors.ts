import { ViteHubError } from "@vite-hub/runtime"

export class BrowserSessionStateError extends ViteHubError<
  "BROWSER_SESSION_STATE",
  { action: string, state: string }
> {
  constructor(action: string, state: string) {
    super("BROWSER_SESSION_STATE", `[vitehub:browser] Cannot ${action} a Browser Session while it is ${state}.`, {
      details: { action, state },
      retryable: false,
    })
    this.name = "BrowserSessionStateError"
  }
}

export class BrowserSessionRefError extends ViteHubError<
  "BROWSER_SESSION_REF_INVALID",
  { reason: "audience" | "expired" | "unknown" }
> {
  constructor(reason: "audience" | "expired" | "unknown") {
    super("BROWSER_SESSION_REF_INVALID", "[vitehub:browser] The Browser Session reference is invalid or no longer claimable.", {
      details: { reason },
      retryable: false,
    })
    this.name = "BrowserSessionRefError"
  }
}

export class BrowserLiveHandoffUnsupportedError extends ViteHubError<
  "BROWSER_LIVE_HANDOFF_UNSUPPORTED",
  { controller?: string, provider: string }
> {
  constructor(provider: string, controller?: string) {
    super(
      "BROWSER_LIVE_HANDOFF_UNSUPPORTED",
      `[vitehub:browser] Live handoff is not supported by ${controller ? `${provider} with ${controller}` : provider}.`,
      {
        details: { provider, ...(controller ? { controller } : {}) },
        retryable: false,
      },
    )
    this.name = "BrowserLiveHandoffUnsupportedError"
  }
}

export class BrowserProviderError extends ViteHubError<
  "BROWSER_PROVIDER_ERROR",
  { operation: string, provider: string, status?: number }
> {
  constructor(provider: string, operation: string, options: { cause?: unknown, status?: number } = {}) {
    super("BROWSER_PROVIDER_ERROR", `[vitehub:browser] ${provider} could not ${operation}.`, {
      cause: options.cause,
      details: { operation, provider, ...(options.status === undefined ? {} : { status: options.status }) },
      retryable: options.status === undefined || options.status >= 500 || options.status === 429,
    })
    this.name = "BrowserProviderError"
  }
}
