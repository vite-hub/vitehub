import type { AccessCapabilityOptions } from "./access.ts"
import type { AgentCapabilityDefinition, AgentRuntimeConfig } from "../types.ts"

export interface AccessCapabilityMetadata<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  access: AccessCapabilityOptions<TRuntimeConfig>
  chat: boolean
  kind: "access"
  workspace: boolean
}

function isAccessMetadata(value: unknown): value is AccessCapabilityMetadata {
  return typeof value === "object"
    && value !== null
    && (value as { kind?: unknown }).kind === "access"
    && typeof (value as { access?: unknown }).access === "object"
    && (value as { access?: unknown }).access !== null
}

export function getAccessCapabilityOptions<TRuntimeConfig extends AgentRuntimeConfig>(
  capabilities: AgentCapabilityDefinition[],
): AccessCapabilityOptions<TRuntimeConfig>[] {
  return capabilities
    .map(capability => capability.id === "access" && isAccessMetadata(capability.metadata) ? capability.metadata.access : undefined)
    .filter((options): options is AccessCapabilityOptions<TRuntimeConfig> => !!options)
}
