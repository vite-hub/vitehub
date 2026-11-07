import discoveredRegistry from "#vitehub/channels/registry"
import { isPlainObject } from "@vite-hub/internal/object"

import { createChannel } from "../client.ts"
import { isChannelDefinition } from "../definition.ts"

import type { ChannelClient, ChannelDefinition, ChannelDefinitionRegistry } from "../types.ts"
import type {
  ChannelDefinitionName,
  ChannelDefinitionSendOptions,
  ChannelRegistryDefinition,
} from "../registry-types.ts"
import { channelErrors, channelsErrorDiagnostics } from "../error-diagnostics.ts"

let registryOverride: ChannelDefinitionRegistry | undefined
let channels = new Map<string, Promise<ChannelClient<unknown>>>()

export function setChannelRuntimeRegistry(registry: ChannelDefinitionRegistry | undefined): void {
  registryOverride = registry
  channels = new Map()
}

function getRegistry(): ChannelDefinitionRegistry {
  return registryOverride || discoveredRegistry
}

/** Loads a discovered Channel Definition by name. `@vite-hub/agent` uses it to resolve `defineAgent({ channels: [name] })`. */
export async function loadChannelDefinition(name: string): Promise<ChannelDefinition | undefined> {
  const registry = getRegistry()
  const entry = Object.hasOwn(registry, name) ? registry[name] : undefined
  if (!entry) return undefined
  const loaded = await entry()
  if (isChannelDefinition(loaded)) return loaded
  if (isPlainObject(loaded) && Object.hasOwn(loaded, "default") && isChannelDefinition(loaded.default)) return loaded.default
  return undefined
}

async function resolveChannel(name: string): Promise<ChannelClient<unknown>> {
  const definition = await loadChannelDefinition(name)
  if (!definition) {
    throw channelsErrorDiagnostics.CHANNELS_R0002({ message: `[vitehub] No Channel Definition was discovered for "${name}".` })
  }
  // SAFETY: A discovered Channel has one adapter; useChannel() types its send options from the registry.
  return createChannel(name, definition) as ChannelClient<unknown>
}

function resolveCachedChannel(name: string): Promise<ChannelClient<unknown>> {
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

/** The Channel with this name from `server/channels`. `send()` works from any server code. */
export function useChannel<const TName extends ChannelDefinitionName>(name: TName): ChannelClient<ChannelDefinitionSendOptions<ChannelRegistryDefinition<TName>>>
export function useChannel<
  TName extends string,
>(name: string extends TName ? TName : never): ChannelClient<Record<string, unknown> | undefined>
export function useChannel(name: string): ChannelClient<unknown> {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw channelsErrorDiagnostics.CHANNELS_R0003({ message: "`useChannel()` requires a non-empty channel name." })
  }

  return {
    name,
    async send(text: string, options?: unknown) {
      let channel: ChannelClient<unknown>
      try {
        channel = await resolveCachedChannel(name)
      }
      catch (cause) {
        return [channelErrors.CHANNEL_DEFINITION_FAILED({ cause, channel: name }), undefined]
      }
      return await channel.send(text, options)
    },
  }
}
