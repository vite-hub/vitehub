import { askJev } from "./internal/ask-runtime.ts"

import type { AskAnswers, AskQuestions } from "./ask.ts"
import type { JevCloudflareGateway } from "./internal/ask-runtime.ts"
import type { AgentUsageRecord } from "./types.ts"

export type { JevCloudflareGateway, JevProvider } from "./internal/ask-runtime.ts"

interface JevSharedOptions {
  /** Custom fetch implementation. Default: `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch
  /** Model ID. Default: `TYPESAFE_DEFAULT_MODEL` with Server Env, else `jev-latest`, or `typesafe-ai/jev` through Vercel AI Gateway. */
  model?: string
}

/**
 * Options for `jev()`. Without `provider`, the client reads the Server Env group `typesafe`, declared with
 * `typesafeEnv()`. With `provider`, it uses only the credentials that you pass.
 */
export type JevOptions = JevSharedOptions & (
  | { apiKey?: undefined, cloudflare?: undefined, provider?: undefined }
  /** The TypeSafe API, with a TypeSafe API key. */
  | { apiKey: string, cloudflare?: undefined, provider: "typesafe" }
  /** Vercel AI Gateway, with an AI Gateway API key. On Vercel, `VERCEL_OIDC_TOKEN` also works. */
  | { apiKey?: string, cloudflare?: undefined, provider: "vercel" }
  /** The TypeSafe API through a Cloudflare AI Gateway custom provider, with a TypeSafe API key. */
  | { apiKey: string, cloudflare: JevCloudflareGateway, provider: "cloudflare" }
)

export interface JevAskOptions {
  /** Receives the model, provider, and token counts of each Jev request. */
  onUsage?: (usage: AgentUsageRecord) => void
  /** Cancels the pending Jev requests. */
  signal?: AbortSignal
}

export interface JevClient {
  /**
   * Answers the questions about `state`. Build the questions with `ask` from `@vite-hub/agent`. Large question sets are
   * sent in sequential bounded requests; transient provider failures are retried.
   */
  ask: <const Q extends AskQuestions>(state: unknown, questions: Q, options?: JevAskOptions) => Promise<AskAnswers<Q>>
}

/**
 * A TypeSafe Jev client. The same questions and answers work through the TypeSafe API, Vercel AI Gateway, and
 * Cloudflare AI Gateway. Use explicit options for credentials that the application stores, such as one key per tenant.
 *
 * ```ts
 * const answers = await jev({ provider: "vercel", apiKey }).ask(email, { spam: ask.if("Is it spam?") })
 * ```
 */
export function jev(options: JevOptions = {}): JevClient {
  return {
    ask: async (state, questions, { onUsage, signal } = {}) => await askJev({
      ...(signal ? { abortSignal: signal } : {}),
      client: options,
      ...(onUsage ? { recordUsage: onUsage } : {}),
    }, state, questions),
  }
}
