// The default Agent Invocation journal without a libSQL driver: D1 or memory, plus local SQLite or libSQL through the
// `libsql` loader. It never references `@libsql/client`, so a Worker build that passes no loader does not ship it.
// It imports no Node builtin, so a Worker that selects D1 or memory starts without Node compatibility.
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../invocations.ts"
import { d1AgentInvocationRetention } from "./d1-retention.ts"
import { defaultAgentInvocationsAuthTokenEnv, defaultAgentInvocationsUrlEnv } from "./default-location.ts"

import type { Client } from "@libsql/client"
import type { openDefaultLibsqlJournal } from "./default-libsql.ts"
import type { AgentInvocationD1Database, AgentInvocationD1Statement } from "./d1.ts"
import type { AgentInvocationObservationOptions, AgentInvocations, AgentInvocationStore } from "../invocations.ts"
import type { AgentRetentionPolicy } from "../retention.ts"

export { defaultAgentInvocationsAuthTokenEnv, defaultAgentInvocationsPath, defaultAgentInvocationsUrlEnv } from "./default-location.ts"

/**
 * Content attributes that the default journal keeps in metadata mode: prompts, results, tool input and output.
 * `input.data` and `result.output` are the structured forms, such as `driver.ask` state and answers.
 */
export const defaultAgentInvocationsMetadataContent: readonly string[] = [
  "channel.effect.content",
  "input.data",
  "input.messages",
  "input.prompt",
  "message.content",
  "result.output",
  "result.text",
  "tool.input",
  "tool.output",
  "vitehub.activity.progress",
  "vitehub.session.title",
]

export interface DefaultAgentInvocationsD1Statement extends AgentInvocationD1Statement {
  bind(...values: unknown[]): DefaultAgentInvocationsD1Statement
  raw(): Promise<unknown[][]>
}

/** A Cloudflare D1Database satisfies this contract. */
export interface DefaultAgentInvocationsD1Database extends AgentInvocationD1Database {
  prepare(query: string): DefaultAgentInvocationsD1Statement
}

/** The Worker env binding that stores the default journal on Cloudflare. */
export interface DefaultAgentInvocationsD1 {
  binding: string
  env: () => Promise<Record<string, unknown>> | Record<string, unknown>
}

/** Loads the libSQL driver of the default journal: `() => import("@vite-hub/agent/internal/default-invocations-libsql")`. */
export type DefaultAgentInvocationsLibsql = () => Promise<{ openDefaultLibsqlJournal: typeof openDefaultLibsqlJournal }>

export interface DefaultAgentInvocationsOptions {
  /** The ViteHub project root. A relative `file:` URL and the default file resolve from it. */
  projectRoot: string
  /** A `file:` or libSQL URL. Defaults to `file:.vitehub/data/agent-invocations.sqlite`. `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` overrides it. Workers reject explicit `file:` URLs. */
  databaseUrl?: string
  /** Store the journal in this D1 binding. `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` selects libSQL instead. */
  d1?: DefaultAgentInvocationsD1
  /** Runtime env vars. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
  observations?: AgentInvocationObservationOptions
  /**
   * Limits for terminal records. The SQLite and libSQL journal keeps every terminal record by default.
   * The D1 journal defaults to 30 days and 10,000 records, and does not support `maxSize`.
   */
  retention?: AgentRetentionPolicy
}

export interface DefaultAgentInvocationsCoreOptions extends DefaultAgentInvocationsOptions {
  /**
   * The libSQL driver for a local SQLite file or a libSQL URL. Without it, a journal that selects one of them throws
   * `AGENT_R1036`. A host omits it when the build stores the journal in D1 or memory, such as a Cloudflare Worker.
   */
  libsql?: DefaultAgentInvocationsLibsql
}

/**
 * The database behind a default journal. `open()` returns the libSQL client that the journal uses, or the migrated
 * D1 binding of the current Worker request.
 */
export type DefaultAgentInvocationsDatabase =
  | { driver: "libsql", open: () => Promise<Client> }
  | { driver: "d1", open: () => Promise<DefaultAgentInvocationsD1Database> }

export interface DefaultAgentInvocationsLocation {
  authToken?: string
  /** `d1:<binding>`, `memory:` on a Worker without a durable store, or the resolved libSQL URL. */
  url: string
}

const databases = new WeakMap<AgentInvocations, DefaultAgentInvocationsDatabase>()

/** Workers have no file system, and the libSQL Web client rejects `file:` URLs. */
function isWorkersRuntime(): boolean {
  const navigator: unknown = Reflect.get(globalThis, "navigator")
  return typeof navigator === "object" && navigator !== null && Reflect.get(navigator, "userAgent") === "Cloudflare-Workers"
}

function runtimeEnv(options: Pick<DefaultAgentInvocationsOptions, "env">): Readonly<Record<string, string | undefined>> {
  return options.env ?? globalThis.process?.env ?? {}
}

/** The selected store before the file system is read. `url` is undefined for the default file. */
type DefaultAgentInvocationsTarget =
  | { kind: "d1", url: string }
  | { kind: "memory", url: "memory:" }
  | { authToken?: string, kind: "remote", url: string }
  | { kind: "file", url?: string }

function selectTarget(options: Omit<DefaultAgentInvocationsOptions, "observations" | "retention">): DefaultAgentInvocationsTarget {
  const env = runtimeEnv(options)
  const configuredUrl = env[defaultAgentInvocationsUrlEnv]?.trim()
  if (!configuredUrl && options.d1) return { kind: "d1", url: `d1:${options.d1.binding}` }
  const url = configuredUrl || options.databaseUrl
  if (url && !/^file:/i.test(url)) {
    const authToken = env[defaultAgentInvocationsAuthTokenEnv]
    return authToken ? { authToken, kind: "remote", url } : { kind: "remote", url }
  }
  // A Worker without a configured store has no durable journal. An explicit file URL is a configuration error.
  if (isWorkersRuntime()) {
    if (url) throw agentDiagnostics.AGENT_R1029()
    return { kind: "memory", url: "memory:" }
  }
  return { kind: "file", url }
}

async function resolveTarget(projectRoot: string, target: DefaultAgentInvocationsTarget): Promise<DefaultAgentInvocationsLocation & { file?: string }> {
  if (target.kind !== "file") return target.kind === "remote" && target.authToken ? { authToken: target.authToken, url: target.url } : { url: target.url! }
  const { resolveLocalJournalFile } = await import("./default-file.ts")
  return resolveLocalJournalFile(projectRoot, target.url)
}

/**
 * Where the default journal stores records. `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` wins over `databaseUrl` and `d1`.
 * It does not create files.
 */
export async function resolveDefaultAgentInvocationsLocation(options: Omit<DefaultAgentInvocationsOptions, "observations" | "retention">): Promise<DefaultAgentInvocationsLocation> {
  const { file: _file, ...location } = await resolveTarget(options.projectRoot, selectTarget(options))
  return location
}

/** Reads the database behind a journal from `createDefaultAgentInvocations()`. Other journals, and the Worker memory journal, return `undefined`. */
export function defaultAgentInvocationsDatabase(invocations: AgentInvocations): DefaultAgentInvocationsDatabase | undefined {
  return databases.get(invocations)
}

/** A store that opens its backing store on the first call. */
function lazyAgentInvocationStore(open: () => Promise<Required<Omit<AgentInvocationStore, "open">> & Pick<AgentInvocationStore, "open">>): Required<AgentInvocationStore> {
  return {
    open: async () => { await (await open()).open?.() },
    claim: async (...input) => (await open()).claim(...input),
    create: async input => (await open()).create(input),
    delete: async id => (await open()).delete(id),
    get: async (...input) => (await open()).get(...input),
    getClaimToken: async id => (await open()).getClaimToken(id),
    getSummary: async id => (await open()).getSummary(id),
    list: async options => (await open()).list(options),
    listAgentNames: async () => (await open()).listAgentNames(),
    listCapabilityIds: async agentName => (await open()).listCapabilityIds(agentName),
    listTriggeredBy: async agentName => (await open()).listTriggeredBy(agentName),
    prune: async options => (await open()).prune(options),
    release: async (id, claimId) => (await open()).release(id, claimId),
    update: async (...input) => (await open()).update(...input),
  }
}

function isD1Database(value: unknown): value is DefaultAgentInvocationsD1Database {
  if (typeof value !== "object" || value === null || !("prepare" in value) || typeof value.prepare !== "function" || !("batch" in value) || typeof value.batch !== "function") return false
  const statement: unknown = value.prepare("SELECT 1")
  return typeof statement === "object" && statement !== null && "raw" in statement && typeof statement.raw === "function"
}

function journal(store: AgentInvocationStore, observations: AgentInvocationObservationOptions | undefined): AgentInvocations {
  return defineAgentInvocations({
    configuration: "content",
    metadataContent: defaultAgentInvocationsMetadataContent,
    observations,
    store,
  })
}

function d1Journal(d1: DefaultAgentInvocationsD1, options: DefaultAgentInvocationsOptions): AgentInvocations {
  const { maxSize, ...limits } = options.retention ?? {}
  if (maxSize !== undefined && maxSize !== false) {
    throw agentDiagnostics.AGENT_R1027({ message: "[vitehub] agent.invocations.retention.maxSize is not supported by the D1 journal, because D1 reports the size of the whole app database. Use maxAge or maxRecords, or set agent.invocations.databaseUrl to a SQLite file." })
  }
  // Check retention at startup, while the store code loads on the first read or write.
  d1AgentInvocationRetention(limits)
  let d1Store: Promise<typeof import("./d1.ts")> | undefined
  const loadD1 = () => d1Store ??= import("./d1.ts").catch((error: unknown) => {
    d1Store = undefined
    throw error
  })
  // Keep only completed initialization; Worker requests cannot share pending I/O.
  const migrated = new WeakSet<DefaultAgentInvocationsD1Database>()
  const open = async () => {
    const binding = (await d1.env())[d1.binding]
    if (!isD1Database(binding)) {
      throw agentDiagnostics.AGENT_R1028({ message: `[vitehub] The Agent Invocation journal requires the D1 binding ${JSON.stringify(d1.binding)} in the Worker env. Configure the Database D1 binding or set agent.invocations.databaseUrl.` })
    }
    if (!migrated.has(binding)) {
      const { d1AgentInvocationSchema } = await loadD1()
      await binding.batch(d1AgentInvocationSchema().map(statement => binding.prepare(statement)))
      migrated.add(binding)
    }
    return binding
  }
  let store: ReturnType<typeof import("./d1.ts").createD1AgentInvocationStore> | undefined
  const invocations = journal(lazyAgentInvocationStore(async () => {
    const { createD1AgentInvocationStore } = await loadD1()
    return store ??= createD1AgentInvocationStore({ database: open, migrate: false, ...limits })
  }), options.observations)
  databases.set(invocations, { driver: "d1", open })
  return invocations
}

function libsqlJournal(target: DefaultAgentInvocationsTarget, options: DefaultAgentInvocationsCoreOptions): AgentInvocations {
  const loadLibsql = options.libsql
  if (!loadLibsql) throw agentDiagnostics.AGENT_R1036()
  // Concurrent first uses share one open. A failed open lets the next use try again.
  let opened: ReturnType<typeof openDefaultLibsqlJournal> | undefined
  const open = () => opened ??= Promise.all([loadLibsql(), resolveTarget(options.projectRoot, target)])
    .then(async ([{ openDefaultLibsqlJournal }, location]) => await openDefaultLibsqlJournal(location, options.retention))
    .catch((error: unknown) => {
      opened = undefined
      throw error
    })
  const invocations = journal(lazyAgentInvocationStore(async () => (await open()).store), options.observations)
  // The store creates its tables on its first operation. Run a cheap read, so that other readers of the client see them.
  let ready: Promise<Client> | undefined
  const database = () => ready ??= open()
    .then(async ({ client, store }) => {
      await store.getSummary("")
      return client
    })
    .catch((error: unknown) => {
      ready = undefined
      throw error
    })
  databases.set(invocations, { driver: "libsql", open: database })
  return invocations
}

/**
 * The journal that ViteHub installs for Agents that set no journal, with the Console on or off.
 * This entry selects SQLite and libSQL only through `libsql`. `@vite-hub/agent/internal/default-invocations` always passes it.
 * It keeps prompts, messages, results, and tool input and output, like `configuration: "content"` with the
 * `defaultAgentInvocationsMetadataContent` attributes.
 * - Local SQLite at `.vitehub/data/agent-invocations.sqlite`, or the `databaseUrl` libSQL URL.
 * - D1 when `d1` is set and `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` is not.
 * - Memory on a Worker without D1 or a configured URL. An explicit `file:` URL throws `AGENT_R1029`.
 */
export function createDefaultAgentInvocations(options: DefaultAgentInvocationsCoreOptions): AgentInvocations {
  const target = selectTarget(options)
  if (options.d1 && target.kind === "d1") return d1Journal(options.d1, options)
  if (target.kind === "memory") return journal(createMemoryAgentInvocationStore(), options.observations)
  return libsqlJournal(target, options)
}
