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
    GATEWAYS_R0001: { ...dynamicError, fix: "Change the gateway option that the message names in the preset call, such as `vercel()` or `chatgpt()`, in `defineAiGateway()`, or in `languageModel()`, as the message says." },
    /** A gateway API key is missing or resolves to an empty value. */
    GATEWAYS_R0002: { ...dynamicError, fix: "Set the API key env variable that the message names in the Server Env, or pass the key option that the message names to the gateway." },
    /** A gateway header value is missing, empty, or has a line break. */
    GATEWAYS_R0003: { ...dynamicError, fix: "Set the header value that the message names, in the env variable or the gateway option that the message names, as one line without line breaks." },
    /** A gateway URL, Cloudflare account ID, or AI Gateway ID is missing or invalid, or the gateway does not serve a model API. */
    GATEWAYS_R0004: { ...dynamicError, fix: "Set the gateway URL, account ID, or gateway ID that the message names by env variable or option, or pass an `api` that the gateway serves to `languageModel(gateway, modelId, { api })`." },
    /** `ask()` was called on a gateway that only routes model requests. */
    GATEWAYS_R0005: { ...dynamicError, fix: "Call `ask()` on a gateway from `typesafe()`, `vercel()`, or `cloudflare()`." },
    /** `ask()` needs the optional `advocaat` package. */
    GATEWAYS_R0006: { ...dynamicError, fix: "Install the `advocaat` package with `pnpm add advocaat`." },
    /** A Jev question is not a question that the `ask` builders make, or it is too large. */
    GATEWAYS_R0007: { ...dynamicError, fix: "Build each question with `ask.choice()`, `ask.score()`, `ask.chance()`, `ask.if()`, or `ask.switch()`, within the limits that the message names." },
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
    GATEWAYS_R0010: { ...dynamicError, fix: "Install the AI SDK provider package that the message names with `pnpm add <package>`." },
    /** `askWithModel()` needs the optional `ai` package. */
    GATEWAYS_R0011: { ...dynamicError, fix: "Install the `ai` package with `pnpm add ai`." },
    /** The model answered a question with a value that is not one of its options. */
    GATEWAYS_R0012: { ...dynamicError, fix: "Ask the question again, or make its prompt and options clearer so that the model picks one of the options. A retry often helps." },
  },
})
