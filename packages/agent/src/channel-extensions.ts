import type { AgentCapabilityDefinition, AgentChannelHistory } from "./types.ts"

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
}
