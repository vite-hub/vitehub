import type {
  AgentAdapterMetadataContext,
  AgentModelResolver,
  AgentRuntimeConfig,
  MaybeResolvable,
} from "./types.ts"
import type { GatewayProviderSettings } from "@ai-sdk/gateway"
import { resolveRuntimeValue } from "@vite-hub/runtime"
import { setModelCallSettings } from "./internal/model-call-settings.ts"

type GatewaySecret = string | { unseal: () => string }

export interface GatewayModelSettings extends Omit<GatewayProviderSettings, "apiKey"> {
  apiKey?: GatewaySecret
  fallbacks?: readonly string[]
}

export type GatewayModelSettingsResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> = MaybeResolvable<GatewayModelSettings, AgentAdapterMetadataContext<TRuntimeConfig>>

function unseal(value: GatewaySecret | undefined): string | undefined {
  return typeof value === "object" ? value.unseal() : value
}

function gatewayApiKey<TRuntimeConfig extends AgentRuntimeConfig>(
  value: GatewaySecret | undefined,
  context: AgentAdapterMetadataContext<TRuntimeConfig>,
): string | undefined {
  if (value !== undefined) return unseal(value)
  const cloudflare = context.cloudflare?.env?.AI_GATEWAY_API_KEY
  if (typeof cloudflare === "string" && cloudflare.trim()) return cloudflare
  return typeof process === "object" && process?.env ? process.env.AI_GATEWAY_API_KEY : undefined
}

export function gateway<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  model: string,
  settings: GatewayModelSettingsResolver<TRuntimeConfig> = {},
): AgentModelResolver<TRuntimeConfig> {
  if (typeof model !== "string" || !model.trim()) {
    throw new TypeError("[vitehub] gateway() requires a non-empty model identifier.")
  }
  return async (context: AgentAdapterMetadataContext<TRuntimeConfig>) => {
    const resolved = await resolveRuntimeValue(settings, context)
    const { apiKey, fallbacks, ...providerSettings } = resolved
    if (fallbacks !== undefined
      && (!Array.isArray(fallbacks) || fallbacks.some(fallback => typeof fallback !== "string" || !fallback.trim()))) {
      throw new TypeError("[vitehub] gateway({ fallbacks }) requires non-empty model identifiers.")
    }
    const { createGateway } = await import("@ai-sdk/gateway")
    const resolvedApiKey = gatewayApiKey(apiKey, context)
    const gatewayModel = createGateway({
      ...providerSettings,
      ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
    })(model)
    return fallbacks?.length
      ? setModelCallSettings(gatewayModel, {
          providerOptions: { gateway: { models: [...fallbacks] } },
        })
      : gatewayModel
  }
}
