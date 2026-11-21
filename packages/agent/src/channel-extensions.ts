import type { WorkspaceName } from "@vite-hub/workspace"

import type {
  AgentCapabilityDefinition,
  AgentChannelHistory,
  AgentChannelTriggerContext,
  AgentDurableChannelTriggerContext,
  AgentRuntimeConfig,
  AgentTriggerDefinition,
} from "./types.ts"

declare module "@vite-hub/channels" {
  /** The Channel options that an Agent reads when it lists the Channel. */
  interface ChannelExtensionOptions {
    /** Trusted Markdown that ViteHub adds to the Agent instructions for each Invocation that this Channel starts. */
    instructions?: string
    /** Capabilities that the Agent gets only for Invocations that this Channel starts. */
    capabilities?: readonly AgentCapabilityDefinition[]
    /** Past messages that `replayChannel()` sends through a trigger. */
    history?: AgentChannelHistory
  }

  /** The Agent webhook host runs triggers, so it types them. With `durableState: true`, `invoke` gets the durable context. */
  interface ChannelTriggerDefiner {
    <TInput, TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig, CALL_OPTIONS = unknown>(
      definition: AgentTriggerDefinition<TRuntimeConfig, WorkspaceName, TInput, CALL_OPTIONS, AgentDurableChannelTriggerContext<TRuntimeConfig>> & { durableState: true },
    ): typeof definition
    <TInput, TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig, CALL_OPTIONS = unknown>(
      definition: AgentTriggerDefinition<TRuntimeConfig, WorkspaceName, TInput, CALL_OPTIONS, AgentChannelTriggerContext<TRuntimeConfig>> & { durableState?: false },
    ): typeof definition
  }
}
