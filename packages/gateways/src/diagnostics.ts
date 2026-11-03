import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one AI gateway failure site. Keep published codes stable.
export const gatewayDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/agents/ai-gateways#errors",
  codes: {
    /** An AI gateway definition is invalid. */
    GATEWAYS_R0001: dynamicError,
    /** A gateway API key is missing or resolves to an empty value. */
    GATEWAYS_R0002: dynamicError,
    /** A gateway header value is missing, empty, or has a line break. */
    GATEWAYS_R0003: dynamicError,
    /** A gateway URL, Cloudflare account ID, or AI Gateway ID is missing or invalid, or the gateway does not serve a model API. */
    GATEWAYS_R0004: dynamicError,
    /** `ask()` was called on a gateway that only routes model requests. */
    GATEWAYS_R0005: dynamicError,
    /** `ask()` needs the optional `advocaat` package. */
    GATEWAYS_R0006: dynamicError,
    /** A Jev question is not a question that the `ask` builders make, or it is too large. */
    GATEWAYS_R0007: dynamicError,
    /** The provider rejected the key with 401 or 403. */
    GATEWAYS_R0008: {
      why: ({ provider, status }: { provider: string, status: number, env?: string, option?: string }) => `[vitehub] The ${provider} Jev provider rejected the API key with HTTP ${status}. The key is missing, expired, or not allowed to call Jev.`,
      fix: ({ env, option = "apiKey" }: { provider: string, status: number, env?: string, option?: string }) => env ? `Set or rotate ${env}.` : `Pass a valid ${option} to the gateway, or rotate the key.`,
    },
    /** The provider still failed after three attempts. */
    GATEWAYS_R0009: {
      why: ({ provider, status, attempts }: { provider: string, status?: number, attempts: number }) => `[vitehub] The ${provider} Jev provider failed${status === undefined ? " to respond" : ` with HTTP ${status}`} after ${attempts} attempts.`,
      fix: "This is usually temporary. Retry later. The cause has the provider response.",
    },
    /** `languageModel()` needs the optional AI SDK provider package of its model API. */
    GATEWAYS_R0010: dynamicError,
  },
})
