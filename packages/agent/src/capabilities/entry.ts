import { defineCapability } from "../capability-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityTypeContract,
  AgentRuntimeConfig,
  AgentTriggerDefinition,
} from "../types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

export interface AgentEntryOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  id: string
  triggers?: Record<string, AgentTriggerDefinition<TRuntimeConfig, Name, any, any>>
}

export interface AgentEntryCapabilityMetadata {
  entry: {
    id: string
  }
  kind: "entry"
}

type EntryCapabilityTypeContract = AgentCapabilityTypeContract

export function entry<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  const TOptions extends AgentEntryOptions<TRuntimeConfig, Name> = AgentEntryOptions<TRuntimeConfig, Name>,
>(
  options: TOptions,
): AgentCapabilityDefinition<TRuntimeConfig, Name, EntryCapabilityTypeContract> {
  return defineCapability({
    id: options.id,
    metadata: {
      entry: {
        id: options.id,
      },
      kind: "entry",
    } satisfies AgentEntryCapabilityMetadata,
    triggers: options.triggers,
  })
}
