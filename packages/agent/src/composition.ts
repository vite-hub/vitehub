import { asMetadataTarget, copyDefinitionDecorations, getAgentLayerOptions } from "./agent-layers.ts"
import { forgeAccessKey } from "./internal/forge-access.ts"
import type { AgentDefinition, AgentInterceptOutputCarrier, AgentSettings } from "./types.ts"

export { activeProviderSandbox } from "./internal/provider-box.ts"
export { recordProviderCheckout } from "./internal/prepared-provider-checkout.ts"
export type { ProviderSandboxSession } from "./internal/provider-box.ts"

/**
 * The resolved settings of an Agent Definition, with its `extends` layers applied. The result is a
 * new object, but its nested values, such as `driver` or `channels`, still belong to the Agent.
 * Replace a field instead of changing it in place, then pass the result to `defineAgent()`.
 * Returns `undefined` for a value that `defineAgent()` did not create.
 */
export function agentSettings(agent: Omit<AgentDefinition, keyof AgentInterceptOutputCarrier> & AgentInterceptOutputCarrier): AgentSettings | undefined {
  const settings = getAgentLayerOptions(agent)
  if (settings) copyDefinitionDecorations(asMetadataTarget(agent), asMetadataTarget(settings))
  return settings
}

/**
 * A copy of a Channel without the GitHub access that `github({ app })` gives to its Agent. Use it
 * when you build an Agent that must not receive the host's GitHub token.
 */
export function withoutForgeAccess<TChannel extends object>(channel: TChannel): TChannel {
  const copy = { ...channel }
  Reflect.deleteProperty(copy, forgeAccessKey)
  return copy
}
