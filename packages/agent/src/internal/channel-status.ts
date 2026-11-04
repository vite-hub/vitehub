import type { AgentChannelDefinition, AgentChannelStateBinding, AgentRuntimeConfig } from "../types.ts"

/** A message that a Channel retries on its next sync. */
export interface AgentChannelRetryingMessage {
  /** Failed sync attempts so far. */
  attempts: number
  /** Last error, redacted and capped. It never contains the message body. */
  error: string
  id: string
}

/** A message that a Channel stopped retrying, so that its cursor could advance. Replay its ID to retry it. */
export interface AgentChannelSkippedMessage extends AgentChannelRetryingMessage {
  /** ISO 8601 time when the Channel skipped the message. */
  skippedAt: string
}

/** Sync health of a Channel that reads a provider cursor, as `vitehub channels status` shows it. */
export interface AgentChannelStatus {
  error?: string
  /** Consecutive failed syncs. 0 after a sync that finished. */
  failures: number
  /** ISO 8601 start of the current failure streak. */
  failingSince?: string
  retrying: AgentChannelRetryingMessage[]
  /** Newest first. */
  skipped: AgentChannelSkippedMessage[]
  /** `failing` after two failed syncs in a row. */
  status: "failing" | "ok"
  /** ISO 8601 time when the cursor last advanced. */
  syncedAt?: string
}

export interface AgentChannelStatusDefinition {
  /** Removes replayed messages from the skipped list. */
  clear(binding: AgentChannelStateBinding, ids: readonly string[]): Promise<void>
  read(binding: AgentChannelStateBinding): Promise<AgentChannelStatus>
}

const agentChannelStatusDefinition = Symbol.for("vitehub.agent.channelStatusDefinition")

export function withAgentChannelStatusDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TChannel extends AgentChannelDefinition<TRuntimeConfig> = AgentChannelDefinition<TRuntimeConfig>,
>(channel: TChannel, definition: AgentChannelStatusDefinition): TChannel {
  Object.defineProperty(channel, agentChannelStatusDefinition, { configurable: true, enumerable: true, value: definition })
  return channel
}

export function getAgentChannelStatusDefinition<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  channel: AgentChannelDefinition<TRuntimeConfig>,
): AgentChannelStatusDefinition | undefined {
  // SAFETY: `withAgentChannelStatusDefinition` is the only writer of this symbol property.
  return (channel as AgentChannelDefinition<TRuntimeConfig> & { [agentChannelStatusDefinition]?: AgentChannelStatusDefinition })[agentChannelStatusDefinition]
}
