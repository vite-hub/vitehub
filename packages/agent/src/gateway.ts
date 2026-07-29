import type {
  AgentAdapterMetadataContext,
  AgentModelResolver,
  AgentRuntimeConfig,
  MaybeResolvable,
} from "./types.ts"
import type { GatewayProviderSettings } from "@ai-sdk/gateway"

type GatewaySecret = string | { unseal: () => string }

export interface GatewayModelSettings extends Omit<GatewayProviderSettings, "apiKey"> {
  apiKey?: GatewaySecret
}

export type GatewayModelSettingsResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> = MaybeResolvable<GatewayModelSettings, AgentAdapterMetadataContext<TRuntimeConfig>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function resolveSettings<TRuntimeConfig extends AgentRuntimeConfig>(
  settings: GatewayModelSettingsResolver<TRuntimeConfig>,
  context: AgentAdapterMetadataContext<TRuntimeConfig>,
): Promise<GatewayModelSettings> {
  if (typeof settings === "function") return await settings(context)
  if (isRecord(settings) && typeof settings.resolve === "function") {
    return await (settings.resolve as (context: AgentAdapterMetadataContext<TRuntimeConfig>) => GatewayModelSettings | Promise<GatewayModelSettings>)(context)
  }
  return settings as GatewayModelSettings
}

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
    const resolved = await resolveSettings(settings, context)
    const { apiKey, ...providerSettings } = resolved
    const { createGateway } = await import("@ai-sdk/gateway")
    return createGateway({
      ...providerSettings,
      ...(apiKey ? { apiKey: unseal(apiKey) } : {}),
    })(model)
  }
}
