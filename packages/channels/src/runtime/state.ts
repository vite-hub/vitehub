import discoveredRegistry from "#vitehub/channels/registry"

import { createChannel } from "../client.ts"

import type { ChannelClient, ChannelConnectorMap, ChannelDefinitionRegistry } from "../types.ts"
import { channelsErrorDiagnostics } from "../error-diagnostics.ts"

let registryOverride: ChannelDefinitionRegistry | undefined

export function setChannelRuntimeRegistry(registry: ChannelDefinitionRegistry | undefined): void {
  registryOverride = registry
}

function getRegistry(): ChannelDefinitionRegistry {
  return registryOverride || discoveredRegistry
}

interface GlobalAgentChannel {
  global?: boolean
  send?: (message: string, target: string) => Promise<{ id?: string }> | { id?: string }
}

async function resolveChannel(name: string): Promise<ChannelClient<ChannelConnectorMap, string>> {
  let selected: GlobalAgentChannel | undefined
  for (const [agentName, load] of Object.entries(getRegistry())) {
    const loaded = await load()
    const agent = ("default" in loaded ? loaded.default : loaded) as { channels?: Record<string, unknown> } | undefined
    const channel = agent?.channels?.[name] as GlobalAgentChannel | undefined
    if (!channel?.global) continue
    if (selected && selected !== channel) {
      throw channelsErrorDiagnostics.CHANNELS_R0002({ message: `[vitehub] Global Channel "${name}" is declared by more than one Agent, including "${agentName}".` })
    }
    selected = channel
  }
  if (!selected) {
    throw channelsErrorDiagnostics.CHANNELS_R0002({ message: `[vitehub] No Agent exposes global Channel "${name}".` })
  }
  if (!selected.send) {
    throw channelsErrorDiagnostics.CHANNELS_R0002({ message: `[vitehub] Global Channel "${name}" does not provide send().` })
  }
  const send = selected.send
  return createChannel(name, {
    connectors: { [name]: { send: (message: string, target: string) => send(message, target) } },
    defaultConnector: name,
  }) as unknown as ChannelClient<ChannelConnectorMap, string>
}

export function useChannel(name: string): ChannelClient<ChannelConnectorMap, string> {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw channelsErrorDiagnostics.CHANNELS_R0003({ message: "`useChannel()` requires a non-empty channel name." })
  }

  let resolved: Promise<ChannelClient<ChannelConnectorMap, string>> | undefined
  return {
    name,
    async send(text, recipient, options) {
      resolved ||= resolveChannel(name)
      return (await resolved).send(text, recipient, options)
    },
  }
}
