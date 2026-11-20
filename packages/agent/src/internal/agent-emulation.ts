import { emulate } from "@vite-hub/gateways"
import { aiGatewayLanguageModel } from "@vite-hub/gateways/internal"
import { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { readHostEnv } from "./builtin-env.ts"

import type { AiGatewayLanguageModelRoute } from "@vite-hub/gateways/internal"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import type { BuiltInEnvContext } from "./builtin-env.ts"

declare global {
  interface ImportMeta {
    /** Nitro replaces it with the build mode in every module that it bundles. */
    dev?: boolean
  }
}

/** The Server Env variable that sends every Agent model request to the AI emulator when it is `emulate`. */
export const modelEmulationEnv = "VITEHUB_MODELS"

/** The host variable with the origin of the AI emulator. */
export const emulatorUrlEnv = "VITEHUB_EMULATE_URL"

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
 * Whether this code runs in production host output. Nitro replaces `import.meta.dev` in every module that it bundles,
 * so a production build, such as a Cloudflare Worker, is `false` even without a `NODE_ENV` binding. Outside a Nitro
 * bundle, `import.meta.dev` is undefined and `NODE_ENV` decides.
 */
function isProduction(host: BuiltInEnvContext): boolean {
  if (import.meta.dev === false) return true
  return readHostEnv(["NODE_ENV"], host) === "production"
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
  if (isProduction(host)) throw agentDiagnostics.AGENT_MODELS_EMULATE_IN_PRODUCTION()
  return true
}

/**
 * The origin of the AI emulator from the `VITEHUB_EMULATE_URL` host variable, or undefined. Like `VITEHUB_MODELS`, it
 * reads no other Server Env value, so an unset required key of a real provider cannot stop an emulated run.
 */
export function emulatorUrl(context: BuiltInEnvContext = {}): string | undefined {
  const url = readHostEnv([emulatorUrlEnv], hostContext(context))
  return typeof url === "string" ? url : undefined
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

/** A model that sends its requests to the AI emulator at `emulatorUrl()`. */
export async function emulatedLanguageModel(modelId: string, api: ModelApi, context: BuiltInEnvContext): Promise<LanguageModelV4> {
  const { languageModel } = await import("@vite-hub/gateways/ai-sdk")
  const url = emulatorUrl(context)
  return languageModel(emulate(url ? { url } : {}), modelId, { api })
}

/**
 * Whether a model already sends its requests to the AI emulator: a model from `emulatedLanguageModel()`, or a wrapper
 * of one that keeps its provider, such as `wrapLanguageModel()`.
 */
export function isEmulatedModel(model: unknown): boolean {
  if (languageModelRoute(model)?.gateway === emulatedGateway) return true
  const provider: unknown = typeof model === "object" && model !== null ? Reflect.get(model, "provider") : undefined
  return typeof provider === "string" && provider.startsWith(`${emulatedGateway}.`)
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
