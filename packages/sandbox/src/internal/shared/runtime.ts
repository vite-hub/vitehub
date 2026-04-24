import { useRuntimeConfig } from 'nitro/runtime-config'
import { getContext } from 'unctx'

type NitroAsyncContext = {
  request?: unknown
}

let requestEventResolver: (() => unknown) | undefined
const nitroAsyncContext = getContext<NitroAsyncContext>('nitro-app')

export function safeUseRequest<TEvent = unknown>() {
  if (requestEventResolver)
    return requestEventResolver() as TEvent

  try {
    return nitroAsyncContext.use().request as TEvent
  }
  catch {
    return undefined
  }
}

export function getRequestEventResolver() {
  return requestEventResolver
}

export function setRequestEventResolver(resolver?: (() => unknown) | undefined) {
  requestEventResolver = resolver
}

export function readRuntimeValue<T>(
  read: (config: ReturnType<typeof useRuntimeConfig>) => T | undefined,
  fallback: () => T | undefined,
): T | undefined {
  try {
    const value = read(useRuntimeConfig())
    if (typeof value !== 'undefined')
      return value
  }
  catch {
    return fallback()
  }

  return fallback()
}

export async function loadRegistryEntry<TEntry, TModule extends { default?: TEntry }>(
  registry: Record<string, TEntry | (() => Promise<TModule>)>,
  name: string,
): Promise<TEntry | undefined> {
  const entry = registry[name]
  if (!entry)
    return undefined
  if (typeof entry === 'function') {
    const mod = await (entry as () => Promise<TModule>)()
    return mod.default
  }
  return entry
}
