import discoveredRegistry from "#vitehub/channels/registry"
import { isPlainObject } from "@vite-hub/internal/object"

import { createChannel, toChannelSendError } from "../client.ts"

import type { ChannelClient, ChannelConnectorMap, ChannelDefinition, ChannelDefinitionRegistry } from "../types.ts"
import type {
  ChannelDefinitionConnectors,
  ChannelDefinitionDefault,
  ChannelDefinitionName,
  ChannelRegistryDefinition,
} from "../registry-types.ts"
import { channelsErrorDiagnostics } from "../error-diagnostics.ts"

let registryOverride: ChannelDefinitionRegistry | undefined
let channels = new Map<string, Promise<ChannelClient>>()

export function setChannelRuntimeRegistry(registry: ChannelDefinitionRegistry | undefined): void {
  registryOverride = registry
  channels = new Map()
}

function getRegistry(): ChannelDefinitionRegistry {
  return registryOverride || discoveredRegistry
}

function isChannelDefinition(value: unknown): value is ChannelDefinition {
  return isPlainObject(value)
    && Object.hasOwn(value, "connectors")
    && Boolean(value.connectors)
}

async function loadChannelDefinition(name: string): Promise<ChannelDefinition | undefined> {
  const registry = getRegistry()
  const entry = Object.hasOwn(registry, name) ? registry[name] : undefined
  if (!entry) return undefined
  const loaded = await entry()
  if (isChannelDefinition(loaded)) return loaded
  if (isPlainObject(loaded) && Object.hasOwn(loaded, "default") && isChannelDefinition(loaded.default)) return loaded.default
  return undefined
}

async function resolveChannel(name: string): Promise<ChannelClient> {
  const definition = await loadChannelDefinition(name)
  if (!definition) {
    throw channelsErrorDiagnostics.CHANNELS_R0002({ message: `[vitehub] No Channel Definition was discovered for "${name}".` })
  }
  return createChannel(name, definition)
}

function resolveCachedChannel(name: string): Promise<ChannelClient> {
  const cache = channels
  const existing = cache.get(name)
  if (existing) return existing
  const pending = resolveChannel(name).catch((cause: unknown) => {
    if (cache.get(name) === pending) cache.delete(name)
    throw cause
  })
  cache.set(name, pending)
  return pending
}

export function useChannel<const TName extends ChannelDefinitionName>(name: TName): ChannelClient<
  ChannelDefinitionConnectors<ChannelRegistryDefinition<TName>>,
  ChannelDefinitionDefault<ChannelRegistryDefinition<TName>>
>
export function useChannel<
  TName extends string,
>(name: string extends TName ? TName : never): ChannelClient<ChannelConnectorMap>
export function useChannel<TConnectors extends ChannelConnectorMap = ChannelConnectorMap>(name: string): ChannelClient<TConnectors> {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw channelsErrorDiagnostics.CHANNELS_R0003({ message: "`useChannel()` requires a non-empty channel name." })
  }

  return {
    name,
    async send(text, options) {
      try {
        return await (await resolveCachedChannel(name)).send(text, options)
      }
      catch (cause) {
        return [toChannelSendError(cause), null]
      }
    },
  }
}
