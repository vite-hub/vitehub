import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"

import { viteHubErrorDiagnostics } from "../../error-diagnostics.ts"

import type { AgentInvocations } from "@vite-hub/agent"
import type { AgentInvocationsOptions, AgentInvocationStore } from "@vite-hub/agent/server"
import type { DatabaseAgentInvocationStoreOptions } from "../../agent/invocations/database.ts"

/** Built-in Invocation journal stores. `database` uses the app's ViteHub Database. `memory` keeps records in the server process. */
export type AgentInvocationsStoreName = "database" | "memory"

type AgentInvocationsJournalOptions = Omit<AgentInvocationsOptions, "store">

/** A built-in store with journal options. `database` selects a ViteHub Database name and defaults to `default`. */
export type AgentInvocationsStoreOptions =
  | AgentInvocationsJournalOptions & { store: "database", database?: string }
  | AgentInvocationsJournalOptions & { store: "memory", database?: never }

/**
 * The `invocations` value of `defineAgent()` from `vite-hub/agent`.
 * `false` records no journal, also when `agent.invocations` sets an app-wide default.
 */
export type AgentInvocationsSetting =
  | AgentInvocationsStoreName
  | false
  | AgentInvocationsStoreOptions
  | AgentInvocationsOptions
  | AgentInvocations

/** The app-wide `agent.invocations` value. Function options, such as `redact`, belong in a per-Agent setting. */
export type AgentInvocationsDefault =
  | AgentInvocationsStoreName
  | false
  | Omit<AgentInvocationsJournalOptions, "redact" | "redactError"> & ({ store: "database", database?: string } | { store: "memory", database?: never })

type DatabaseStoreModule = {
  createDatabaseAgentInvocationStore: (options?: DatabaseAgentInvocationStoreOptions) => AgentInvocationStore
}

type AgentInvocationsRuntime = {
  [databaseStoreLoaderKey]?: () => Promise<DatabaseStoreModule>
  [defaultInvocationsKey]?: { invocations: AgentInvocations, key: string }
}

const databaseStoreLoaderKey: unique symbol = Symbol.for("vitehub.agent.invocations.database-store")
const defaultInvocationsKey: unique symbol = Symbol.for("vitehub.agent.invocations.default")

/** Marks an Agent Definition that sets `invocations: false`. The Console does not attach a journal to it. */
export const agentInvocationsDisabledKey: unique symbol = Symbol.for("vitehub.agent.invocations.disabled")

function runtime(): AgentInvocationsRuntime {
  // SAFETY: AgentInvocationsRuntime adds only optional symbol-keyed state to the global object.
  return globalThis as AgentInvocationsRuntime
}

async function loadDatabaseStore(options: DatabaseAgentInvocationStoreOptions): Promise<AgentInvocationStore> {
  const load = runtime()[databaseStoreLoaderKey]
  if (!load) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0130({ message: "[vitehub] Agent invocations \"database\" requires ViteHub Database. Set `database` in vitehub() and run the Agent in the ViteHub server." })
  }
  return (await load()).createDatabaseAgentInvocationStore(options)
}

/** A Database store that loads the Database runtime on its first operation. */
function deferredDatabaseStore(options: DatabaseAgentInvocationStoreOptions): AgentInvocationStore {
  let pending: Promise<AgentInvocationStore> | undefined
  const store = () => pending ??= loadDatabaseStore(options).catch((error: unknown) => {
    pending = undefined
    throw error
  })
  return {
    claim: async (...args) => await (await store()).claim(...args),
    create: async input => await (await store()).create(input),
    delete: async (id) => {
      const target = await store()
      if (!target.delete) throw new TypeError("[vitehub] The Database Invocation store does not support delete.")
      return await target.delete(id)
    },
    get: async (...args) => await (await store()).get(...args),
    getClaimToken: async id => await (await store()).getClaimToken(id),
    getSummary: async id => await (await store()).getSummary(id),
    list: async options => await (await store()).list(options),
    listAgentNames: async () => await (await store()).listAgentNames?.() ?? [],
    listCapabilityIds: async agentName => await (await store()).listCapabilityIds?.(agentName) ?? [],
    listTriggeredBy: async agentName => await (await store()).listTriggeredBy?.(agentName) ?? [],
    prune: async (options) => {
      const target = await store()
      if (!target.prune) throw new TypeError("[vitehub] The Database Invocation store does not support prune.")
      return await target.prune(options)
    },
    release: async (...args) => await (await store()).release(...args),
    update: async (...args) => await (await store()).update(...args),
  }
}

function journal(setting: AgentInvocationsStoreName | AgentInvocationsStoreOptions): AgentInvocations {
  if (setting === "database" || setting === "memory") return journal({ store: setting })
  const { database, store, ...options } = setting
  return defineAgentInvocations({
    ...options,
    store: store === "database" ? deferredDatabaseStore(database === undefined ? {} : { database }) : createMemoryAgentInvocationStore(),
  })
}

/** Resolve an `invocations` setting to its journal. `false` and `undefined` resolve to no journal. */
export function resolveAgentInvocationsSetting(setting: AgentInvocationsSetting | undefined): AgentInvocations | undefined {
  if (setting === undefined || setting === false) return undefined
  if (setting === "database" || setting === "memory") return journal(setting)
  if (!("store" in setting)) return setting
  if ("database" in setting && setting.database !== undefined && setting.store !== "database") {
    throw new TypeError("[vitehub] Agent invocations accept `database` only with `store: \"database\"`.")
  }
  if (setting.store === "database" || setting.store === "memory") {
    // SAFETY: The checks above select the built-in store form.
    return journal(setting as AgentInvocationsStoreOptions)
  }
  // SAFETY: A store object selects the custom store form.
  return defineAgentInvocations(setting as AgentInvocationsOptions)
}

/** The app-wide journal for Agent Definitions that do not set `invocations`. */
export function resolveDefaultAgentInvocations(): AgentInvocations | undefined {
  return runtime()[defaultInvocationsKey]?.invocations
}

/**
 * Generated server code calls this before Agents run.
 * `database` loads the Database store. `default` is the app-wide `agent.invocations` value.
 */
export function installAgentInvocations(options: { database?: () => Promise<DatabaseStoreModule>, default?: AgentInvocationsDefault }): void {
  const state = runtime()
  if (options.database) state[databaseStoreLoaderKey] = options.database
  else delete state[databaseStoreLoaderKey]
  if (options.default === undefined || options.default === false) {
    delete state[defaultInvocationsKey]
    return
  }
  const key = JSON.stringify(options.default)
  // Keep one journal per setting when development reloads the generated plugin.
  if (state[defaultInvocationsKey]?.key === key) return
  state[defaultInvocationsKey] = { invocations: journal(options.default), key }
}
