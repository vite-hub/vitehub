import discoveredRegistry from "#vitehub/channels/registry"
import { resolveChannelRuntimeEnv } from "#vitehub/channels/runtime"

import { createChannel } from "../client.ts"

import type { ChannelClient, ChannelConnectorMap, ChannelDefinitionInput, ChannelDefinitionRegistry } from "../types.ts"
import type {
  ChannelDefinitionConnectors,
  ChannelDefinitionDefault,
  ChannelDefinitionName,
  ChannelRegistryDefinition,
} from "../registry-types.ts"

let registryOverride: ChannelDefinitionRegistry | undefined

export function setChannelRuntimeRegistry(registry: ChannelDefinitionRegistry | undefined): void {
  registryOverride = registry
}

function getRegistry(): ChannelDefinitionRegistry {
  return registryOverride || discoveredRegistry
}

function isChannelDefinition(value: unknown): value is ChannelDefinitionInput {
  return typeof value === "function" || Boolean(value && typeof value === "object" && (value as { connectors?: unknown }).connectors)
}

async function loadChannelDefinition(name: string): Promise<ChannelDefinitionInput | undefined> {
  const entry = getRegistry()[name]
  if (!entry) return undefined
  const loaded = await entry()
  if (isChannelDefinition(loaded)) return loaded
  if (loaded && typeof loaded === "object" && "default" in loaded && isChannelDefinition(loaded.default)) return loaded.default
  return undefined
}

async function resolveChannel<TConnectors extends ChannelConnectorMap>(name: string): Promise<ChannelClient<TConnectors>> {
  const definition = await loadChannelDefinition(name)
  if (!definition) {
    throw new Error(`[vitehub] No Channel Definition was discovered for "${name}".`)
  }
  return createChannel(name, definition as unknown as ChannelDefinitionInput<TConnectors>, resolveChannelRuntimeEnv)
}

export function useChannel<const TName extends ChannelDefinitionName>(name: TName): ChannelClient<
  ChannelDefinitionConnectors<ChannelRegistryDefinition<TName>>,
  ChannelDefinitionDefault<ChannelRegistryDefinition<TName>>
>
export function useChannel<
  TConnectors extends ChannelConnectorMap = ChannelConnectorMap,
  TDefault extends keyof TConnectors & string = never,
>(name: string): ChannelClient<TConnectors, TDefault>
export function useChannel<TConnectors extends ChannelConnectorMap = ChannelConnectorMap>(name: string): ChannelClient<TConnectors> {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new TypeError("`useChannel()` requires a non-empty channel name.")
  }

  let resolved: Promise<ChannelClient<TConnectors>> | undefined
  return {
    name,
    async send(text, options) {
      resolved ||= resolveChannel<TConnectors>(name)
      return (await resolved).send(text, options)
    },
  }
}
