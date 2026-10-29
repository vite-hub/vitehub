import type { AskAnswers, AskQuestions } from "./ask.ts"

/** What a gateway value resolver receives. */
export interface AiGatewayContext {
  /** Aborts a resolver that reads remote storage. */
  abortSignal?: AbortSignal
  /**
   * Reads one value that a preset did not receive, such as `typesafe` `apiKey`. ViteHub Agents read Server Env here.
   * Without it, presets read `process.env`: the `VITEHUB_<PRESET>_<FIELD>` name, then the vendor names.
   */
  env?: (preset: string, field: string) => unknown
}

/** A value, or a resolver that runs each time the gateway is used. */
export type AiGatewayValue<T> = T | ((context: AiGatewayContext) => T | Promise<T>) | { resolve: (context: AiGatewayContext) => T | Promise<T> }

/** A secret that hides its value until `unseal()`, such as a ViteHub Server Env secret. */
export interface AiGatewaySealedSecret {
  unseal: () => string | undefined
}

/**
 * A gateway API key or header value: a string, a sealed secret, or a resolver. `undefined` or an empty string fails the
 * request, so optional Server Env values can be passed directly.
 */
export type AiGatewaySecret = AiGatewayValue<string | AiGatewaySealedSecret | undefined>

/** The provider Drivers that a gateway can serve. */
export type AiGatewayDriver = "claude-code" | "codex"

/** What an AI gateway does besides routing the model requests of provider Drivers. */
export interface AiGatewayCapabilities {
  /** The gateway answers TypeSafe Jev questions with `gateway.ask()`. */
  ask: boolean
}

/** A record of one request's model, provider, and token counts. */
export interface AiGatewayUsage {
  model?: string
  provider: string
  usage: { inputTokens?: number, outputTokens?: number, totalTokens?: number }
}

export interface AiGatewayAskOptions {
  /** Receives the model, provider, and token counts of each Jev request. */
  onUsage?: (usage: AiGatewayUsage) => void
  /** Cancels the pending Jev requests. */
  signal?: AbortSignal
}

/**
 * Answers TypeSafe Jev questions about `state`. Build the questions with `ask`. Large question sets are sent in
 * sequential bounded requests, and transient provider failures are retried.
 */
export type AiGatewayAsk = <const Q extends AskQuestions>(state: unknown, questions: Q, options?: AiGatewayAskOptions) => Promise<AskAnswers<Q>>

/** How a provider Driver reaches an AI gateway: a base URL per Driver, the key, and extra headers. */
export interface AiGatewayDefinition {
  /** Name shown in inspection and diagnostics. */
  name: string
  /**
   * Base URL for each Driver. Codex sends OpenAI Responses requests to `<url>/responses`.
   * Claude Code sends Anthropic Messages requests to `<url>/v1/messages`.
   * A Driver without an entry cannot use this gateway.
   */
  baseURL: Partial<Record<AiGatewayDriver, AiGatewayValue<string>>>
  /** API key. When it is not set, the first non-empty variable in `apiKeyEnv` is read. */
  apiKey?: AiGatewaySecret
  /** Process environment variables that supply the API key, in lookup order. */
  apiKeyEnv?: readonly string[]
  /** How the gateway receives the API key. `"bearer"` (default) sends `Authorization: Bearer`. `"x-api-key"` sends `x-api-key`. */
  auth?: "bearer" | "x-api-key"
  /** Extra request headers, such as Cloudflare Access service-token headers. Values are treated as secrets. */
  headers?: Record<string, AiGatewaySecret>
}

/**
 * An AI gateway: where the model requests of provider Drivers go and, when `TCapabilities` has `ask: true`, where
 * TypeSafe Jev questions go (`gateway.ask()`). Build one with a preset or with `defineAiGateway()`.
 */
export type AiGateway<TCapabilities extends Partial<AiGatewayCapabilities> = Partial<AiGatewayCapabilities>> = AiGatewayDefinition & (
  TCapabilities["ask"] extends true ? { ask: AiGatewayAsk }
    : TCapabilities["ask"] extends false ? { ask?: never }
      : { ask?: AiGatewayAsk }
)
