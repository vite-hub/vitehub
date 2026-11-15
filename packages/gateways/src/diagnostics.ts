import { defineDiagnostics } from "nostics"

import { recordPublicAiGatewayDiagnostic } from "./public-diagnostics.ts"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one AI gateway failure site. Keep published codes stable.
export const gatewayDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/gateways/diagnostics",
  reporters: [recordPublicAiGatewayDiagnostic],
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
    /** `askWithModel()` needs the optional `ai` package. */
    GATEWAYS_R0011: dynamicError,
    /** The model answered a question with a value that is not one of its options. */
    GATEWAYS_R0012: dynamicError,
    // Named errors. Keep these codes in alphabetical order.
    GATEWAYS_ASK_EACH_KEY_DUPLICATE: {
      why: ({ key }: { key: string }) => `ask.each produced duplicate key ${key}`,
      fix: "Return a different key for each item from the `key` function of `ask.each(items, { key, question })`, such as the item id.",
    },
    GATEWAYS_ASK_EACH_KEY_INVALID: {
      why: "ask.each keys must be non-empty strings",
      fix: "Return a non-empty string from the `key` function of `ask.each(items, { key, question })` for every item.",
    },
    GATEWAYS_ASK_THRESHOLD_INVALID: {
      why: ({ problem }: { problem: "finite" | "range" }) => problem === "finite" ? "ask.if threshold must be a finite number" : "ask.if threshold must be between 0 and 1",
      fix: "Pass `ask.if(instructions, { threshold })` a number from 0 to 1, or omit `threshold` to use 0.5.",
    },
    GATEWAYS_JEV_INPUT_TOO_LARGE: {
      why: ({ question }: { question?: string }) => question === undefined
        ? "[vitehub] Jev shared state exceeds the safe per-question input budget."
        : `[vitehub] Jev question "${question}" exceeds the safe per-question input budget.`,
      fix: "Pass less shared state to the ask, or split a long question into shorter ones, so each question with the shared state stays under 30,000 bytes of JSON.",
    },
    GATEWAYS_JEV_RESPONSE_INVALID: {
      why: ({ name, problem }: { name: string, problem: "choice" | "missing" }) => problem === "missing"
        ? `[vitehub] Jev response is missing answer "${name}".`
        : `[vitehub] Jev choice answer "${name}" is missing a valid probability distribution.`,
      fix: "Retry the ask, because the Jev service sent an incomplete answer. If it repeats, update the `advocaat` package and check the Jev service status.",
    },
  },
})
