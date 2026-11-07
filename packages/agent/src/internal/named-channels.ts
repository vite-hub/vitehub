import { agentDiagnostics } from "../agent-diagnostics.ts"

import type { AgentChannelDefinition, AgentChannels, AgentRuntimeConfig } from "../types.ts"

const definitionsKey = Symbol.for("vitehub.agent.channelDefinitions")
// An enumerable symbol, so the names survive when Agent layers copy the Channel record.
const channelNamesKey = Symbol.for("vitehub.agent.channelNames")

type DefinitionsHolder = typeof globalThis & { [definitionsKey]?: Map<string, unknown> }

function channelDefinitions(): Map<string, unknown> {
  return (globalThis as DefinitionsHolder)[definitionsKey] ??= new Map()
}

/**
 * Hands Channels of `server/channels` to the Agent runtime by name. ViteHub adds a call to each Agent module that
 * lists Channels by name, before the module runs, with only the Channels it lists. The route chunk and the public
 * entry can load as separate module instances in dev, so they share one global.
 */
export function registerAgentChannels(definitions: Record<string, unknown>): void {
  const registry = channelDefinitions()
  for (const [name, value] of Object.entries(definitions)) {
    registry.set(name, value !== null && typeof value === "object" && "default" in value ? (value as { default: unknown }).default : value)
  }
}

/** Resolves `defineAgent({ channels: ['slack'] })` to the registered Channels, in order. */
export function namedAgentChannels<TRuntimeConfig extends AgentRuntimeConfig>(
  names: readonly unknown[],
  resolve: (value: unknown, name: string) => AgentChannelDefinition<TRuntimeConfig>,
): AgentChannels<TRuntimeConfig> {
  const registry = channelDefinitions()
  const record: AgentChannels<TRuntimeConfig> = {}
  for (const name of names) {
    if (typeof name !== "string" || !name.trim()) {
      throw agentDiagnostics.AGENT_R0425({ message: "[vitehub] defineAgent({ channels }) lists Channel names, such as ['slack'], from server/channels." })
    }
    if (Object.hasOwn(record, name)) {
      throw agentDiagnostics.AGENT_R0425({ message: `[vitehub] defineAgent({ channels }) lists the Channel "${name}" twice.` })
    }
    if (!registry.has(name)) {
      throw agentDiagnostics.AGENT_R0425({ message: `[vitehub] The Agent lists the Channel "${name}", which is not registered. ViteHub registers server/channels/${name}.ts when it builds an Agent in server/agents. In other code, pass the Channel inline: channels: { ${name}: channel }.` })
    }
    record[name] = resolve(registry.get(name), name)
  }
  Object.defineProperty(record, channelNamesKey, { enumerable: true, value: [...names] })
  return record
}

/** The Channel names of `defineAgent({ channels: [...] })`, or undefined for Channels that the Agent defines inline. */
export function agentChannelNames(channels: unknown): readonly string[] | undefined {
  if (channels === null || typeof channels !== "object") return undefined
  const names: unknown = (channels as Record<PropertyKey, unknown>)[channelNamesKey]
  return Array.isArray(names) ? names as readonly string[] : undefined
}

/** The Agent that lists each Channel by name. Two Agents cannot answer the same Channel. */
export function namedChannelHosts(agents: Record<string, unknown>): Record<string, string> {
  const hosts: Record<string, string> = {}
  for (const [agentName, agent] of Object.entries(agents)) {
    const options = agent !== null && typeof agent === "object"
      ? agent as { channels?: unknown, __vitehubWorkspaceAgentOptions?: { channels?: unknown } }
      : undefined
    for (const channel of agentChannelNames(options?.channels ?? options?.__vitehubWorkspaceAgentOptions?.channels) ?? []) {
      if (hosts[channel] && hosts[channel] !== agentName) {
        throw agentDiagnostics.AGENT_R0425({ message: `[vitehub] The Agents "${hosts[channel]}" and "${agentName}" both list the Channel "${channel}". A Channel sends its messages to one Agent.` })
      }
      hosts[channel] = agentName
    }
  }
  return hosts
}
