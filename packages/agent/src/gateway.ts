import type {
  AgentAdapterMetadataContext,
  AgentModelResolver,
  AgentRuntimeConfig,
  MaybeResolvable,
} from "./types.ts"
import type { GatewayProviderSettings } from "@ai-sdk/gateway"
import { resolveRuntimeValue } from "@vite-hub/runtime"

type GatewaySecret = string | { unseal: () => string }

export interface GatewayModelSettings extends Omit<GatewayProviderSettings, "apiKey"> {
  apiKey?: GatewaySecret
}

export type GatewayModelSettingsResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> = MaybeResolvable<GatewayModelSettings, AgentAdapterMetadataContext<TRuntimeConfig>>

function unseal(value: GatewaySecret | undefined): string | undefined {
  return typeof value === "object" ? value.unseal() : value
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
    const { apiKey, ...providerSettings } = resolved
    const { createGateway } = await import("@ai-sdk/gateway")
    return createGateway({
      ...providerSettings,
      ...(apiKey ? { apiKey: unseal(apiKey) } : {}),
    })(model)
  }
}
