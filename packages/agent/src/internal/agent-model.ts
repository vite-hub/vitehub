import type {
  AgentAdapterMetadataContext,
  AgentGatewayModel,
  AgentModelInput,
  AgentRuntimeConfig,
} from "../types.ts"
import type { LanguageModel } from "ai"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { emulatedLanguageModel, emulatedModelApi, emulatedModelObject, resolveModelEmulation } from "./agent-emulation.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isLanguageModel(value: Record<string, unknown>): boolean {
  return typeof value.doGenerate === "function"
    && typeof value.doStream === "function"
    && typeof value.modelId === "string"
    && typeof value.provider === "string"
}

export function gatewayModelDescriptor(model: AgentModelInput): AgentGatewayModel | undefined {
  if (typeof model === "string") return { id: model }
  if (!isRecord(model)) return
  const record = model as Record<string, unknown>
  if (isLanguageModel(record)) return
  if (typeof record.id !== "string") return
  if (Object.keys(record).some(key => key !== "apiKey" && key !== "id")) return
  return record as unknown as AgentGatewayModel
}

function unseal(value: AgentGatewayModel["apiKey"]): string | undefined {
  if (typeof value !== "object") return value
  if (typeof value.unseal !== "function") {
    throw agentDiagnostics.AGENT_R0512({ message: "[vitehub] Agent model apiKey must be a string or sealed value." })
  }
  return value.unseal()
}

function gatewayApiKey<TRuntimeConfig extends AgentRuntimeConfig>(
  value: AgentGatewayModel["apiKey"],
  context: Pick<AgentAdapterMetadataContext<TRuntimeConfig>, "cloudflare">,
): string | undefined {
  if (value !== undefined) {
    const apiKey = unseal(value)
    if (!apiKey?.trim()) {
      throw agentDiagnostics.AGENT_R0513({ message: "[vitehub] Agent model apiKey must be non-empty when provided." })
    }
    return apiKey
  }
  const cloudflare = context.cloudflare?.env?.AI_GATEWAY_API_KEY
  if (typeof cloudflare === "string" && cloudflare.trim()) return cloudflare
  return typeof process === "object" && process?.env ? process.env.AI_GATEWAY_API_KEY : undefined
}

/**
 * The language model of an Agent model input. Every model entry point calls it. With `VITEHUB_MODELS=emulate`, it
 * returns a model on the AI emulator and reads no credential, or it fails for a model that it cannot send there.
 */
export async function materializeAgentModel<TRuntimeConfig extends AgentRuntimeConfig>(
  model: AgentModelInput,
  context: Pick<AgentAdapterMetadataContext<TRuntimeConfig>, "cloudflare">,
): Promise<LanguageModel> {
  const descriptor = gatewayModelDescriptor(model)
  const id = descriptor?.id.trim()
  if (descriptor && !id) {
    throw agentDiagnostics.AGENT_R0514({ message: "[vitehub] Agent model identifiers must be non-empty." })
  }
  if (resolveModelEmulation(context)) {
    return id ? await emulatedLanguageModel(id, emulatedModelApi(id), context) : await emulatedModelObject(model, context)
  }
  if (!descriptor || !id) return model as LanguageModel
  // `ai` re-exports the gateway it depends on. A separate @ai-sdk/gateway import can resolve a second copy.
  const { createGateway } = await import("ai")
  const apiKey = gatewayApiKey(descriptor.apiKey, context)
  return (apiKey ? createGateway({ apiKey }) : createGateway())(id)
}
