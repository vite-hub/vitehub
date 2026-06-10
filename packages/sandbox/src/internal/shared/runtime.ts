let requestEventResolver: (() => unknown) | undefined

export function safeUseRequest<TEvent = unknown>() {
  if (requestEventResolver)
    return requestEventResolver() as TEvent

  return undefined
}

export function getRequestEventResolver() {
  return requestEventResolver
}

export function setRequestEventResolver(resolver?: (() => unknown) | undefined) {
  requestEventResolver = resolver
}

export function readRuntimeValue<T>(
  read: (config: Record<string, unknown>) => T | undefined,
  fallback: () => T | undefined,
): T | undefined {
  const value = read({})
  return typeof value === 'undefined' ? fallback() : value
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
