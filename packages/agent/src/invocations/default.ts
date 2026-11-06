// The default Agent Invocation journal: local SQLite or libSQL, or D1 on Cloudflare.
// libSQL loads on the first read or write, so a server that records no run does not load it.
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../invocations.ts"
import { createD1AgentInvocationStore, d1AgentInvocationSchema } from "./d1.ts"
import { defaultAgentInvocationsAuthTokenEnv, defaultAgentInvocationsPath, defaultAgentInvocationsUrlEnv } from "./default-location.ts"

import type { Client } from "@libsql/client"
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

export interface DefaultAgentInvocationsOptions {
  /** The ViteHub project root. A relative `file:` URL and the default file resolve from it. */
  projectRoot: string
  /** A `file:` or libSQL URL. Defaults to `file:.vitehub/data/agent-invocations.sqlite`. `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` overrides it. */
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

function localFile(projectRoot: string, url: string): { file?: string, url: string } {
  const fragmentIndex = url.indexOf("#")
  const urlWithoutFragment = fragmentIndex === -1 ? url : url.slice(0, fragmentIndex)
  const queryIndex = urlWithoutFragment.indexOf("?")
  const fileUrl = queryIndex === -1 ? urlWithoutFragment : urlWithoutFragment.slice(0, queryIndex)
  const query = queryIndex === -1 ? "" : urlWithoutFragment.slice(queryIndex)
  const isAbsoluteFileUrl = /^file:\//i.test(fileUrl)
  const relativeFilePath = isAbsoluteFileUrl ? undefined : decodeURIComponent(fileUrl.slice("file:".length))
  if (relativeFilePath === ":memory:") return { url: urlWithoutFragment }
  const file = isAbsoluteFileUrl ? fileURLToPath(fileUrl) : resolve(projectRoot, relativeFilePath!)
  return { file, url: `${pathToFileURL(file).href}${query}` }
}

/**
 * Where the default journal stores records. `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` wins over `databaseUrl` and `d1`.
 * It does not touch the file system.
 */
export function resolveDefaultAgentInvocationsLocation(options: Omit<DefaultAgentInvocationsOptions, "observations" | "retention">): DefaultAgentInvocationsLocation {
  const env = runtimeEnv(options)
  const configuredUrl = env[defaultAgentInvocationsUrlEnv]?.trim()
  if (!configuredUrl && options.d1) return { url: `d1:${options.d1.binding}` }
  const url = configuredUrl || options.databaseUrl || `file:${resolve(options.projectRoot, defaultAgentInvocationsPath)}`
  if (!/^file:/i.test(url)) {
    const authToken = env[defaultAgentInvocationsAuthTokenEnv]
    return authToken ? { authToken, url } : { url }
  }
  // A Worker without a D1 binding or a remote URL has no durable journal.
  if (isWorkersRuntime()) return { url: "memory:" }
  return { url: localFile(options.projectRoot, url).url }
}

/** Reads the database behind a journal from `createDefaultAgentInvocations()`. Other journals, and the Worker memory journal, return `undefined`. */
export function defaultAgentInvocationsDatabase(invocations: AgentInvocations): DefaultAgentInvocationsDatabase | undefined {
  return databases.get(invocations)
}

/** A store that opens its backing store on the first call. */
function lazyAgentInvocationStore(open: () => Promise<Required<AgentInvocationStore>>): Required<AgentInvocationStore> {
  return {
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
  // Keep only completed initialization; Worker requests cannot share pending I/O.
  const migrated = new WeakSet<DefaultAgentInvocationsD1Database>()
  const open = async () => {
    const binding = (await d1.env())[d1.binding]
    if (!isD1Database(binding)) {
      throw agentDiagnostics.AGENT_R1028({ message: `[vitehub] The Agent Invocation journal requires the D1 binding ${JSON.stringify(d1.binding)} in the Worker env. Configure the Database D1 binding or set agent.invocations.databaseUrl.` })
    }
    if (!migrated.has(binding)) {
      await binding.batch(d1AgentInvocationSchema().map(statement => binding.prepare(statement)))
      migrated.add(binding)
    }
    return binding
  }
  const invocations = journal(createD1AgentInvocationStore({ database: open, migrate: false, ...limits }), options.observations)
  databases.set(invocations, { driver: "d1", open })
  return invocations
}

function libsqlJournal(location: DefaultAgentInvocationsLocation, options: DefaultAgentInvocationsOptions): AgentInvocations {
  const retention = options.retention
  // Concurrent first uses share one open. A failed open lets the next use try again.
  let opened: Promise<{ client: Client, store: Required<AgentInvocationStore> }> | undefined
  const open = () => opened ??= Promise.all([import("@libsql/client"), import("./sqlite.ts")])
    .then(([{ createClient }, { createLibsqlAgentInvocationStore }]) => {
      if (/^file:/i.test(location.url)) {
        const { file } = localFile(options.projectRoot, location.url)
        if (file) mkdirSync(dirname(file), { recursive: true })
      }
      const client = createClient(location)
      try {
        return {
          client,
          store: createLibsqlAgentInvocationStore({
            client,
            // Keep invalid values, such as null, so that the store rejects them.
            maxAge: retention?.maxAge === undefined ? false : retention.maxAge,
            maxRecords: retention?.maxRecords === undefined ? false : retention.maxRecords,
            maxSize: retention?.maxSize === undefined ? false : retention.maxSize,
          }),
        }
      }
      catch (error) {
        client.close()
        throw error
      }
    })
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
 * It keeps prompts, messages, results, and tool input and output, like `configuration: "content"` with the
 * `defaultAgentInvocationsMetadataContent` attributes.
 * - Local SQLite at `.vitehub/data/agent-invocations.sqlite`, or the `databaseUrl` libSQL URL.
 * - D1 when `d1` is set and `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` is not.
 * - Memory on a Worker without D1 or a remote URL.
 */
export function createDefaultAgentInvocations(options: DefaultAgentInvocationsOptions): AgentInvocations {
  const location = resolveDefaultAgentInvocationsLocation(options)
  if (options.d1 && location.url.startsWith("d1:")) return d1Journal(options.d1, options)
  if (location.url === "memory:") return journal(createMemoryAgentInvocationStore(), options.observations)
  return libsqlJournal(location, options)
}
