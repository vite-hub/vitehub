import { createDefaultAgentInvocations, resolveDefaultAgentInvocationsLocation } from "@vite-hub/agent/invocations/default"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"

import { viteHubErrorDiagnostics } from "../../error-diagnostics.ts"
import { isDefaultAgentJournal } from "../../agent-invocations-setting.ts"

import type { AgentInvocations } from "@vite-hub/agent"
import type { DefaultAgentInvocationsD1 } from "@vite-hub/agent/invocations/default"
import type { AgentInvocationObservationOptions, AgentInvocationsOptions, AgentInvocationStore, AgentRetentionPolicy } from "@vite-hub/agent/server"
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

/**
 * Options of the default journal, which ViteHub installs for Agents that set no journal.
 * It is local SQLite at `.vitehub/data/agent-invocations.sqlite`, or D1 in a Cloudflare production build.
 */
export interface AgentInvocationsDefaultJournal {
  /**
   * A `file:` or libSQL URL for the journal. A relative `file:` path resolves from the ViteHub project root.
   * `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` overrides it at runtime.
   */
  databaseUrl?: string
  /** Observation count, string length, byte budget, and flush timeout of each record. */
  observations?: AgentInvocationObservationOptions
  /**
   * Remove old terminal records by `maxAge`, `maxRecords`, or `maxSize`. SQLite and libSQL keep every record by default.
   * The D1 journal defaults to 30 days and 10,000 records, and does not support `maxSize`.
   */
  retention?: AgentRetentionPolicy
  database?: never
  store?: never
}

/**
 * The app-wide `agent.invocations` value. Omit it, or pass the default journal options, for the default journal.
 * `false` records no journal. Function options, such as `redact`, belong in a per-Agent setting.
 */
export type AgentInvocationsDefault =
  | AgentInvocationsStoreName
  | false
  | AgentInvocationsDefaultJournal
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

/** Where the default journal of a generated server lives. */
export interface DefaultAgentJournalLocation {
  /** Store the journal in this D1 binding. A Cloudflare production build sets it from the default Database Definition. */
  d1?: DefaultAgentInvocationsD1
  /** The ViteHub project root. The default journal file and relative `file:` URLs resolve from it. */
  projectRoot: string
}

/**
 * Generated server code calls this before Agents run, with the Console on or off.
 * `database` loads the Database store. `default` is the app-wide `agent.invocations` value.
 * With `journal`, an omitted `default` installs the default journal. Without `journal`, it installs none.
 */
export function installAgentInvocations(options: { database?: () => Promise<DatabaseStoreModule>, default?: AgentInvocationsDefault, journal?: DefaultAgentJournalLocation }): void {
  const state = runtime()
  if (options.database) state[databaseStoreLoaderKey] = options.database
  else delete state[databaseStoreLoaderKey]
  const setting = options.default
  if (setting === false || (setting === undefined && !options.journal)) {
    delete state[defaultInvocationsKey]
    return
  }
  if (isDefaultAgentJournal(setting)) {
    if (!options.journal) {
      throw viteHubErrorDiagnostics.VITE_HUB_R0138({ message: "[vitehub] The default Agent Invocation journal needs the project root. Run the Agent in the ViteHub server." })
    }
    if (globalThis.process?.env?.VITEHUB_CONSOLE_DATABASE_URL?.trim()) {
      throw viteHubErrorDiagnostics.VITE_HUB_R0139({ message: "[vitehub] VITEHUB_CONSOLE_DATABASE_URL was renamed. Set VITEHUB_AGENT_INVOCATIONS_DATABASE_URL, and VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN for an authenticated libSQL endpoint." })
    }
    const { d1, projectRoot } = options.journal
    const location = resolveDefaultAgentInvocationsLocation({ d1, databaseUrl: setting?.databaseUrl, projectRoot })
    const key = JSON.stringify({ location: location.url, observations: setting?.observations, projectRoot, retention: setting?.retention })
    // Keep one journal per location and options when development reloads the generated plugin.
    if (state[defaultInvocationsKey]?.key === key) return
    state[defaultInvocationsKey] = { invocations: createDefaultAgentInvocations({ ...setting, d1, projectRoot }), key }
    return
  }
  const key = JSON.stringify(setting)
  // Keep one journal per setting when development reloads the generated plugin.
  if (state[defaultInvocationsKey]?.key === key) return
  state[defaultInvocationsKey] = { invocations: journal(setting), key }
}
