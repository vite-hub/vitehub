import { emulate } from "@vite-hub/gateways"
import { aiGatewayLanguageModel } from "@vite-hub/gateways/internal"
import { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { readHostEnv } from "./builtin-env.ts"
import { gatewayEnvValue } from "./gateway-env.ts"

import type { AiGatewayLanguageModelRoute } from "@vite-hub/gateways/internal"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import type { BuiltInEnvContext } from "./builtin-env.ts"

/** The Server Env variable that sends every Agent model request to the AI emulator when it is `emulate`. */
export const modelEmulationEnv = "VITEHUB_MODELS"

/** The gateway name that Invocation and inspection metadata show for an emulated model. */
export const emulatedGateway = "emulate"

type ModelApi = AiGatewayLanguageModelRoute["api"]

function hostContext(context: BuiltInEnvContext): BuiltInEnvContext {
  const env = context.cloudflare?.env ?? getActiveCloudflareEnv()
  return env ? { ...context, cloudflare: { env } } : context
}

/** Whether `VITEHUB_MODELS=emulate` is set. It never throws, so inspection can show the switch in every environment. */
export function isModelEmulationRequested(context: BuiltInEnvContext = {}): boolean {
  return readHostEnv([modelEmulationEnv], hostContext(context)) === "emulate"
}

/**
 * Whether Agent models run on the AI emulator. A run calls it before it reads a credential or builds a model.
 * The switch fails in production, and an unknown value fails, so a typo never reaches a real provider.
 */
export function resolveModelEmulation(context: BuiltInEnvContext = {}): boolean {
  const host = hostContext(context)
  const value = readHostEnv([modelEmulationEnv], host)
  if (value === undefined) return false
  if (value !== "emulate") throw agentDiagnostics.AGENT_MODELS_INVALID({ value: String(value) })
  if (readHostEnv(["NODE_ENV"], host) === "production") throw agentDiagnostics.AGENT_MODELS_EMULATE_IN_PRODUCTION()
  return true
}

/** The route of a model from `languageModel()` or the ChatGPT plan, or undefined for any other model object. */
export function languageModelRoute(model: unknown): AiGatewayLanguageModelRoute | undefined {
  if (typeof model !== "object" || model === null) return
  const route: unknown = Reflect.get(model, aiGatewayLanguageModel)
  if (typeof route !== "object" || route === null) return
  // SAFETY: Only languageModel() and the ChatGPT plan model set this symbol, with a frozen route.
  return route as AiGatewayLanguageModelRoute
}

/**
 * The model API of an AI Gateway model ID on the emulator: `openai/*` uses OpenAI Responses, `anthropic/*` uses
 * Anthropic Messages, and every other ID uses Chat Completions.
 */
export function emulatedModelApi(id: string): ModelApi {
  if (id.startsWith("openai/")) return "responses"
  if (id.startsWith("anthropic/")) return "messages"
  return "chat"
}

/** A model that sends its requests to the AI emulator. The URL comes from `VITEHUB_EMULATE_URL` in Server Env. */
export async function emulatedLanguageModel(modelId: string, api: ModelApi, context: BuiltInEnvContext): Promise<LanguageModelV4> {
  const [{ languageModel }, url] = await Promise.all([
    import("@vite-hub/gateways/ai-sdk"),
    gatewayEnvValue("emulate", "url", hostContext(context)),
  ])
  return languageModel(emulate(typeof url === "string" && url ? { url } : {}), modelId, { api })
}

/**
 * The emulated form of a model object. A model from `languageModel()` or the ChatGPT plan keeps its model API and ID.
 * Any other model object calls its own provider, so it fails instead.
 */
export async function emulatedModelObject(model: unknown, context: BuiltInEnvContext): Promise<LanguageModelV4> {
  const route = languageModelRoute(model)
  if (route) return await emulatedLanguageModel(route.modelId, route.api, context)
  const provider: unknown = typeof model === "object" && model !== null ? Reflect.get(model, "provider") : undefined
  throw agentDiagnostics.AGENT_MODELS_EMULATE_MODEL_UNSUPPORTED({ provider: typeof provider === "string" && provider ? provider : "unknown" })
}
