import { defineDiagnostics } from "nostics"

import { recordPublicAiGatewayDiagnostic } from "./public-diagnostics.ts"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

export const gatewayDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/gateways/diagnostics",
  reporters: [recordPublicAiGatewayDiagnostic],
  codes: {
    GATEWAYS_R0001: { ...dynamicError, fix: "Change the gateway option that the message names in the preset call, such as `vercel()` or `chatgpt()`, in `defineAiGateway()`, or in `languageModel()`, as the message says." },
    GATEWAYS_R0002: { ...dynamicError, fix: "Set the API key env variable that the message names in the Server Env, or pass the key option that the message names to the gateway." },
    GATEWAYS_R0003: { ...dynamicError, fix: "Set the header value that the message names, in the env variable or the gateway option that the message names, as one line without line breaks." },
    GATEWAYS_R0004: { ...dynamicError, fix: "Set the gateway URL, account ID, or gateway ID that the message names by env variable or option, or pass an `api` that the gateway serves to `languageModel(gateway, modelId, { api })`." },
    GATEWAYS_R0005: { ...dynamicError, fix: "Call `ask()` on a gateway from `typesafe()`, `vercel()`, or `cloudflare()`." },
    GATEWAYS_R0006: { ...dynamicError, fix: "Install the `advocaat` package with `pnpm add advocaat`." },
    GATEWAYS_R0007: { ...dynamicError, fix: "Build each question with `ask.choice()`, `ask.score()`, `ask.chance()`, `ask.if()`, or `ask.switch()`, within the limits that the message names." },
    GATEWAYS_R0008: {
      why: ({ provider, status }: { provider: string, status: number, env?: string, option?: string }) => `[vitehub] The ${provider} Jev provider rejected the API key with HTTP ${status}. The key is missing, expired, or not allowed to call Jev.`,
      fix: ({ env, option = "apiKey" }: { provider: string, status: number, env?: string, option?: string }) => env ? `Set or rotate ${env}.` : `Pass a valid ${option} to the gateway, or rotate the key.`,
    },
    GATEWAYS_R0009: {
      why: ({ provider, status, attempts }: { provider: string, status?: number, attempts: number }) => `[vitehub] The ${provider} Jev provider failed${status === undefined ? " to respond" : ` with HTTP ${status}`} after ${attempts} attempts.`,
      fix: "This is usually temporary. Retry later. The cause has the provider response.",
    },
    GATEWAYS_R0010: { ...dynamicError, fix: "Install the AI SDK provider package that the message names with `pnpm add <package>`." },
    GATEWAYS_R0011: { ...dynamicError, fix: "Install the `ai` package with `pnpm add ai`." },
    GATEWAYS_R0012: { ...dynamicError, fix: "Ask the question again, or make its prompt and options clearer so that the model picks one of the options. A retry often helps." },
    // Named errors.
    GATEWAYS_ASK_EACH_KEY_DUPLICATE: {
      why: ({ key }: { key: string }) => `ask.each produced duplicate key ${key}`,
      fix: "Return a different key for each item from the `key` function of `ask.each(items, { key, question })`, such as the item id.",
    },
    GATEWAYS_ASK_EACH_KEY_INVALID: {
      why: "ask.each keys must be non-empty strings",
      fix: "Return a non-empty string from the `key` function of `ask.each(items, { key, question })` for every item.",
    },
    GATEWAYS_ASK_MODEL_FAILED: {
      why: ({ status }: { status?: number }) => `[vitehub] The ask() model request failed${status === undefined ? "" : ` with HTTP ${status}`}.`,
      fix: "Check the model ID and the gateway key. For HTTP 429 or 5xx, retry later. The cause has the provider response.",
    },
    GATEWAYS_ASK_OUTPUT_INVALID: {
      why: ({ finishReason, issue }: { finishReason?: string, issue?: string }) => finishReason !== undefined
        ? `[vitehub] The model answer to ask() has no text. The model stopped with finish reason "${finishReason}".`
        : `[vitehub] The model answer to ask() is not JSON that the schema accepts${issue === undefined ? "." : `: ${issue}`}`,
      fix: "Ask again, because a retry often helps. If it repeats, describe each field in the schema or the prompt, or make the schema less strict. For finish reason \"content-filter\", change the prompt. For \"length\", shorten the prompt or use a model with a larger output limit.",
    },
    GATEWAYS_ASK_PROMPT_INVALID: {
      why: "ask() needs a non-empty prompt string",
      fix: "Pass the question as the first argument: `ask('Summarize this run', { model, schema })`.",
    },
    GATEWAYS_ASK_SCHEMA_INVALID: {
      why: ({ problem, vendor }: { problem: "json-schema" | "standard", vendor?: string }) => problem === "standard"
        ? "ask() needs a Standard Schema in `schema`"
        : `ask() needs a schema that converts to JSON Schema, and this ${vendor} schema does not`,
      fix: "Pass a Zod 4 or ArkType schema, or wrap a Valibot schema with `toStandardJsonSchema()` from `@valibot/to-json-schema`.",
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
