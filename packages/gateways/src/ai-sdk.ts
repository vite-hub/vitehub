import { aiGatewaySupports, resolveAiGatewayModelRoute } from "./definition.ts"
import { gatewayDiagnostics } from "./diagnostics.ts"

import type { LanguageModelV4 } from "@ai-sdk/provider"
import type { AiGatewayModelRoute } from "./definition.ts"
import type { AiGateway, AiGatewayRoute } from "./types.ts"

/**
 * The model APIs that `languageModel()` can call, for the routes of a gateway:
 * - `chat`: OpenAI Chat Completions at the `openai-compatible` URL, with `@ai-sdk/openai-compatible`.
 * - `responses`: OpenAI Responses at the `openai-compatible` URL, else at the `codex` URL, with `@ai-sdk/openai`.
 * - `messages`: Anthropic Messages at the `claude-code` URL, with `@ai-sdk/anthropic`.
 */
export type AiGatewayModelApi<TRoutes extends AiGatewayRoute = AiGatewayRoute> =
  | ("openai-compatible" extends TRoutes ? "chat" | "responses" : never)
  | ("codex" extends TRoutes ? "responses" : never)
  | ("claude-code" extends TRoutes ? "messages" : never)

export interface AiGatewayLanguageModelOptions<TApi extends AiGatewayModelApi = AiGatewayModelApi> {
  /** The model API to call. Default: `chat` when the gateway has an `openai-compatible` URL, else `messages`, else `responses`. */
  api?: TApi
  /** Custom fetch implementation for model requests. Default: `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch
}

/** Rejects a gateway that serves no model API, such as `typesafe()`, with a readable type error. */
type ServesModels<TRoutes extends AiGatewayRoute> = [AiGatewayModelApi<TRoutes>] extends [never]
  ? { readonly "This gateway serves no model API. Use a gateway with an openai-compatible, claude-code, or codex baseURL.": never }
  : unknown

const packages = {
  "chat": "@ai-sdk/openai-compatible",
  "messages": "@ai-sdk/anthropic",
  "responses": "@ai-sdk/openai",
} as const

function defaultApi(gateway: AiGateway): AiGatewayModelApi {
  if (aiGatewaySupports(gateway, "openai-compatible")) return "chat"
  if (aiGatewaySupports(gateway, "claude-code")) return "messages"
  return "responses"
}

function routeOf(gateway: AiGateway, api: AiGatewayModelApi): AiGatewayRoute {
  if (api === "messages") return "claude-code"
  if (api === "responses" && !aiGatewaySupports(gateway, "openai-compatible")) return "codex"
  return "openai-compatible"
}

async function load<T>(api: AiGatewayModelApi, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer()
  }
  catch (error) {
    throw gatewayDiagnostics.GATEWAYS_R0010({
      message: `[vitehub] The "${api}" model API needs the ${packages[api]} package. Install it with: pnpm add ${packages[api]}`,
      cause: error,
    })
  }
}

function headerRecord(route: AiGatewayModelRoute): Record<string, string> {
  return Object.fromEntries([...route.headers, ...(route.auth === "x-api-key" && route.apiKey ? [["x-api-key", route.apiKey]] : [])])
}

async function createModel(gateway: AiGateway, modelId: string, api: AiGatewayModelApi, fetch: typeof globalThis.fetch | undefined, abortSignal: AbortSignal | undefined): Promise<LanguageModelV4> {
  const route = await resolveAiGatewayModelRoute(gateway, routeOf(gateway, api), abortSignal ? { abortSignal } : {})
  const headers = headerRecord(route)
  const shared = { headers, name: gateway.name, ...(fetch ? { fetch } : {}) }
  if (api === "chat") {
    const { createOpenAICompatible } = await load(api, async () => await import("@ai-sdk/openai-compatible"))
    return createOpenAICompatible({
      ...shared,
      baseURL: route.baseURL,
      // Without it, streamed responses carry no token counts.
      includeUsage: true,
      ...(route.apiKey && route.auth === "bearer" ? { apiKey: route.apiKey } : {}),
    }).chatModel(modelId)
  }
  if (!route.apiKey) {
    throw gatewayDiagnostics.GATEWAYS_R0002({ message: `[vitehub] Gateway "${gateway.name}" needs an API key for the "${api}" model API. Pass apiKey, or use api: "chat".` })
  }
  if (api === "responses") {
    const { createOpenAI } = await load(api, async () => await import("@ai-sdk/openai"))
    return createOpenAI({ ...shared, apiKey: route.apiKey, baseURL: route.baseURL }).responses(modelId)
  }
  const { createAnthropic } = await load(api, async () => await import("@ai-sdk/anthropic"))
  return createAnthropic({
    ...shared,
    baseURL: `${route.baseURL}/v1`,
    ...(route.auth === "x-api-key" ? { apiKey: route.apiKey } : { authToken: route.apiKey }),
  }).languageModel(modelId)
}

/**
 * An AI SDK language model that sends its requests through the gateway. The gateway resolves its URL, key, and headers
 * for each request, from the values that you passed to the preset or from `process.env`.
 *
 * @example
 * import { generateText } from 'ai'
 * import { openrouter } from '@vite-hub/gateways'
 * import { languageModel } from '@vite-hub/gateways/ai-sdk'
 *
 * await generateText({ model: languageModel(openrouter(), 'google/gemini-3-flash'), prompt: 'Hello' })
 */
export function languageModel<const TRoutes extends AiGatewayRoute>(
  gateway: AiGateway<{ routes: TRoutes }> & ServesModels<TRoutes>,
  modelId: string,
  options: AiGatewayLanguageModelOptions<AiGatewayModelApi<TRoutes>> = {},
): LanguageModelV4 {
  if (typeof gateway !== "object" || gateway === null || typeof gateway.baseURL !== "object" || gateway.baseURL === null) {
    throw gatewayDiagnostics.GATEWAYS_R0001({ message: "[vitehub] languageModel(gateway, modelId) needs a gateway from a preset or defineAiGateway(). chatgpt() serves the Codex Driver only." })
  }
  if (typeof modelId !== "string" || !modelId.trim()) throw gatewayDiagnostics.GATEWAYS_R0001({ message: "[vitehub] languageModel(gateway, modelId) needs a non-empty model ID." })
  const api: AiGatewayModelApi = options.api ?? defaultApi(gateway)
  if (!packages[api]) throw gatewayDiagnostics.GATEWAYS_R0001({ message: `[vitehub] languageModel() api must be "chat", "responses", or "messages".` })
  const route = routeOf(gateway, api)
  if (!aiGatewaySupports(gateway, route)) {
    throw gatewayDiagnostics.GATEWAYS_R0004({ message: `[vitehub] Gateway "${gateway.name}" does not serve the "${api}" model API. Set baseURL["${route}"] or choose another api.` })
  }
  const id = modelId.trim()
  const model = async (abortSignal?: AbortSignal) => await createModel(gateway, id, api, options.fetch, abortSignal)
  return {
    specificationVersion: "v4",
    provider: `${gateway.name}.${api}`,
    modelId: id,
    // Read when a request starts, so it resolves the gateway route like a model call does.
    get supportedUrls() {
      return model().then(resolved => resolved.supportedUrls)
    },
    doGenerate: async callOptions => await (await model(callOptions.abortSignal)).doGenerate(callOptions),
    doStream: async callOptions => await (await model(callOptions.abortSignal)).doStream(callOptions),
  }
}
