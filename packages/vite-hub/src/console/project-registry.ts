export type ConsoleProjectRegistry<TValue> = {
  get(key: string): TValue | undefined
  set(key: string, value: TValue): unknown
  readonly size: number
}

type ConsoleProjectScope = {
  process?: unknown
  [key: symbol]: unknown
}

function sharedProcess(scope: ConsoleProjectScope): ConsoleProjectScope | undefined {
  // Vite SSR module runners isolate globalThis but retain the host Node process object.
  if (!scope.process || (typeof scope.process !== "object" && typeof scope.process !== "function")) return
  // SAFETY: The module adds only optional symbol-keyed state to the shared process.
  return scope.process as ConsoleProjectScope
}

/** Owns project selection, shared-process fallback, and ambiguity for one Console inspection. */
export function createConsoleProjectRegistry<TValue>(keys: { root: symbol, value: symbol, registry: symbol }) {
  function projectRegistry(value: unknown): ConsoleProjectRegistry<TValue> | undefined {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return
    // SAFETY: The checks below validate all registry members; only this module writes values for its configured keys.
    const registry = value as Partial<ConsoleProjectRegistry<TValue>>
    if (typeof registry.get !== "function" || typeof registry.set !== "function" || !Number.isInteger(registry.size)) return
    // SAFETY: Every member of ConsoleProjectRegistry was checked above.
    return registry as ConsoleProjectRegistry<TValue>
  }

  return {
    install(projectRoot: string, value: TValue, scope: ConsoleProjectScope): TValue {
      scope[keys.root] = projectRoot
      scope[keys.value] = value
      const process = sharedProcess(scope)
      if (process) {
        const registry = projectRegistry(process[keys.registry]) ?? new Map<string, TValue>()
        registry.set(projectRoot, value)
        process[keys.registry] = registry
        process[keys.value] = value
      }
      return value
    },
    resolve(scope: ConsoleProjectScope): TValue | undefined {
      const process = sharedProcess(scope)
      const registry = projectRegistry(process?.[keys.registry])
      // SAFETY: install is the writer for the configured root and value keys.
      const root = scope[keys.root] as string | undefined
      // SAFETY: install writes a TValue under the configured local value key.
      const local = scope[keys.value] as TValue | undefined
      if (root) return registry?.get(root) ?? local
      if (registry && registry.size > 1) return local
      // SAFETY: install writes a TValue under the configured shared-process value key.
      return process?.[keys.value] as TValue | undefined ?? local
    },
  }
}
