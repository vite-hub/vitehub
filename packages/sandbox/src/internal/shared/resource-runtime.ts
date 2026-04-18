import {
  createInvalidNamedResourceError,
  createUnknownNamedResourceError,
  resolveNamedResourceName,
} from './named-resource'
import { loadRegistryEntry, readRuntimeValue, safeUseRequest } from './runtime'

export interface ProviderPort<TResolvedProvider, THandle, TContext> {
  resolve: (context: TContext) => Promise<TResolvedProvider> | TResolvedProvider
  validate?: (provider: TResolvedProvider, context: TContext) => Promise<void> | void
  create: (provider: TResolvedProvider, context: TContext) => Promise<THandle> | THandle
}

export interface ResourceRuntimeContext<TConfig, TDefinition, TEvent = unknown> {
  feature: string
  name: string
  event: TEvent | undefined
  config: TConfig | false | undefined
  definition: TDefinition
}

export interface ResourceRuntimeRegistry<TDefinition, TModule extends { default?: TDefinition } = { default?: TDefinition }> {
  entries: Record<string, TDefinition | (() => Promise<TModule>)>
  validate?: (definition: TDefinition) => boolean
}

export interface RuntimeCachePolicy<TResolvedProvider, THandle, TContext> {
  store: Map<string, Promise<THandle>>
  isSafe: (provider: TResolvedProvider, context: TContext) => boolean
  getKey?: (context: TContext) => string
}

export interface ResourceRuntimeOptions<TConfig, TDefinition, TResolvedProvider, THandle, TEvent = unknown> {
  feature: string
  readConfig: (runtimeConfig: Record<string, unknown>) => TConfig | false | undefined
  getFallbackConfig: () => TConfig | false | undefined
  registry: ResourceRuntimeRegistry<TDefinition>
  port: ProviderPort<TResolvedProvider, THandle, ResourceRuntimeContext<TConfig, TDefinition, TEvent>>
  cache?: RuntimeCachePolicy<TResolvedProvider, THandle, ResourceRuntimeContext<TConfig, TDefinition, TEvent>>
}

export function readFeatureRuntimeConfig<TConfig>(
  readConfig: (runtimeConfig: Record<string, unknown>) => TConfig | false | undefined,
  getFallbackConfig: () => TConfig | false | undefined,
) {
  return readRuntimeValue(
    config => readConfig(config as Record<string, unknown>),
    getFallbackConfig,
  )
}

export async function loadResourceRuntimeContext<TConfig, TDefinition, TEvent = unknown>(
  options: Omit<ResourceRuntimeOptions<TConfig, TDefinition, never, never, TEvent>, 'port' | 'cache'>,
  name?: string,
): Promise<ResourceRuntimeContext<TConfig, TDefinition, TEvent>> {
  const resolvedName = resolveNamedResourceName(options.feature, name)
  const [config, definition] = await Promise.all([
    Promise.resolve(readFeatureRuntimeConfig(options.readConfig, options.getFallbackConfig)),
    loadRegistryEntry(options.registry.entries, resolvedName),
  ])

  if (!definition)
    throw createUnknownNamedResourceError(options.feature, resolvedName)
  if (options.registry.validate && !options.registry.validate(definition))
    throw createInvalidNamedResourceError(options.feature, resolvedName)

  return {
    feature: options.feature,
    name: resolvedName,
    event: safeUseRequest<TEvent>(),
    config,
    definition,
  }
}

export interface ResourceRuntime<TConfig, TDefinition, THandle, TEvent = unknown> {
  load: (name?: string) => Promise<ResourceRuntimeContext<TConfig, TDefinition, TEvent>>
  get: (name?: string) => Promise<THandle>
}

export function createResourceRuntime<TConfig, TDefinition, TResolvedProvider, THandle, TEvent = unknown>(
  options: ResourceRuntimeOptions<TConfig, TDefinition, TResolvedProvider, THandle, TEvent>,
): ResourceRuntime<TConfig, TDefinition, THandle, TEvent> {
  async function load(name?: string): Promise<ResourceRuntimeContext<TConfig, TDefinition, TEvent>> {
    return await loadResourceRuntimeContext(options, name)
  }

  async function createHandle(context: ResourceRuntimeContext<TConfig, TDefinition, TEvent>) {
    const provider = await options.port.resolve(context)
    await options.port.validate?.(provider, context)
    return { provider, handle: await options.port.create(provider, context) }
  }

  async function get(name?: string) {
    const context = await load(name)
    const cache = options.cache
    if (!cache) {
      return (await createHandle(context)).handle
    }

    const { provider } = await createHandleWithoutConstruct(context, options.port)
    if (!cache.isSafe(provider, context)) {
      return await options.port.create(provider, context)
    }

    const cacheKey = cache.getKey?.(context) ?? context.name
    const existing = cache.store.get(cacheKey)
    if (existing)
      return await existing

    const pending = Promise.resolve(options.port.create(provider, context))
      .catch((error) => {
        cache.store.delete(cacheKey)
        throw error
      })
    cache.store.set(cacheKey, pending)
    return await pending
  }

  return {
    load,
    get,
  }
}

async function createHandleWithoutConstruct<TConfig, TDefinition, TResolvedProvider, THandle, TEvent = unknown>(
  context: ResourceRuntimeContext<TConfig, TDefinition, TEvent>,
  port: ProviderPort<TResolvedProvider, THandle, ResourceRuntimeContext<TConfig, TDefinition, TEvent>>,
) {
  const provider = await port.resolve(context)
  await port.validate?.(provider, context)
  return { provider }
}
