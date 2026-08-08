import type {
  AgentAdapterMetadataContext,
  AgentGatewayModel,
  AgentModelInput,
  AgentRuntimeConfig,
} from "../types.ts"
import type { LanguageModel } from "ai"

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
    throw new TypeError("[vitehub] Agent model apiKey must be a string or sealed value.")
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
      throw new TypeError("[vitehub] Agent model apiKey must be non-empty when provided.")
    }
    return apiKey
  }
  const cloudflare = context.cloudflare?.env?.AI_GATEWAY_API_KEY
  if (typeof cloudflare === "string" && cloudflare.trim()) return cloudflare
  return typeof process === "object" && process?.env ? process.env.AI_GATEWAY_API_KEY : undefined
}

export async function materializeAgentModel<TRuntimeConfig extends AgentRuntimeConfig>(
  model: AgentModelInput,
  context: Pick<AgentAdapterMetadataContext<TRuntimeConfig>, "cloudflare">,
): Promise<LanguageModel> {
  const descriptor = gatewayModelDescriptor(model)
  if (!descriptor) return model as LanguageModel
  const id = descriptor.id.trim()
  if (!id) {
    throw new TypeError("[vitehub] Agent model identifiers must be non-empty.")
  }
  const { createGateway } = await import("@ai-sdk/gateway")
  const apiKey = gatewayApiKey(descriptor.apiKey, context)
  return (apiKey ? createGateway({ apiKey }) : createGateway())(id)
}
