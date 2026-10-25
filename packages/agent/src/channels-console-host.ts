import type { AgentInput } from "./types.ts"
import type { AgentChannelWebhookRouteHandler, AgentChannelWebhookRouteOptions } from "./server/routes.ts"

/**
 * What the Channel operations read: the Agents of the app, their webhook handlers, and the options that the webhook
 * routes pass to them (State, identity, capabilities). The generated webhook route module installs it, so the Console
 * reads a conversation with the same State and adapters that the webhook wrote it with.
 */
export interface ChannelsConsoleHost {
  agents: Readonly<Record<string, AgentInput>>
  handlers: Readonly<Record<string, AgentChannelWebhookRouteHandler>>
  /** The route options of an Agent. `env` is the Cloudflare environment of the call, which a Durable Object State needs. */
  options(agent: string, env?: Record<string, unknown>): AgentChannelWebhookRouteOptions
}

const hostKey: unique symbol = Symbol.for("vitehub.agent.channels-console")
// SAFETY: This module owns the process slot that the generated route module and the operations share.
const scope = globalThis as typeof globalThis & { [hostKey]?: ChannelsConsoleHost }

export function installChannelsConsoleHost(host: ChannelsConsoleHost): void {
  scope[hostKey] = host
}

export function channelsConsoleHost(): ChannelsConsoleHost | undefined {
  return scope[hostKey]
}

/** The Channel does not exist on the Agent, or has no per-thread conversation. */
export class ChannelUnknownError extends Error {}

/** No Invocation of the Channel and no transcript knows the thread, so it is not read. */
export class ChannelThreadUnknownError extends Error {}

/** The Channel has no Chat adapter that can read the thread. */
export class ChannelAdapterUnavailableError extends Error {}

/** The conversation is larger than an archive may be. */
export class ChannelArchiveTooLargeError extends Error {}

/** The State of the Agent cannot read what a conversation needs. */
export class ChannelStateUnavailableError extends Error {}
