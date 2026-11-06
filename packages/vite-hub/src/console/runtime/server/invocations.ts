import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { d1AgentInvocationRetention } from "@vite-hub/agent/server/internal"

import {
  createConsoleInvocationsIdentity,
  installConsoleInvocationFallback,
  resolveConsoleInvocations,
  resolveConsoleInvocationsIdentity,
} from "../../internal.ts"

import type { Value } from "@libsql/client"
import type { ConsoleD1Database, ConsoleInvocationsDatabase, ConsoleLibsqlJournal } from "./invocations-database.ts"
import type { ConsoleUsageClient, createConsoleUsageIndex } from "./usage-index.ts"
import type { AgentInvocationStore, AgentInvocations } from "@vite-hub/agent"
import type { AgentInvocationsOptions, AgentRetentionPolicy } from "@vite-hub/agent/server"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"
import { consoleD1MaxSizeError } from "../../retention.ts"

export type { ConsoleInvocationsDatabase } from "./invocations-database.ts"

// Content attributes that the Console journal keeps in metadata mode: prompts, results, tool input and output.
// `input.data` and `result.output` are the structured forms, such as `driver.ask` state and answers.
export const consoleMetadataContent = [
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
] as const

const consoleUsageIndexes = new WeakMap<AgentInvocations, ReturnType<typeof createConsoleUsageIndex>>()

export function getConsoleUsageIndex(invocations: AgentInvocations): ReturnType<typeof createConsoleUsageIndex> | undefined {
  return consoleUsageIndexes.get(invocations)
}

const consoleInvocationDatabases = new WeakMap<AgentInvocations, () => Promise<ConsoleInvocationsDatabase>>()
const consoleDatabaseConfigurations = new WeakMap<AgentInvocations, string>()
const consoleObservationConfigurations = new WeakMap<AgentInvocations, string>()

function observationConfiguration(observations: AgentInvocationsOptions["observations"], retention?: AgentRetentionPolicy): string {
  const configuration = JSON.stringify(observations, ["maxCount", "maxStringLength", "maxBytes", "flushTimeoutMs"]) ?? "undefined"
  return retention === undefined ? configuration : `${configuration}:${JSON.stringify(retention, ["maxAge", "maxRecords", "maxSize"])}`
}

export function getConsoleInvocations(): AgentInvocations {
  const invocations = resolveConsoleInvocations()
  if (!invocations) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0063({ message: "[vitehub] The Agent invocation console has not been installed for this runtime." })
  }
  return invocations
}

/** Opens the Console journal database on first use. */
export async function getConsoleInvocationsDatabase(): Promise<ConsoleInvocationsDatabase> {
  const invocations = getConsoleInvocations()
  const database = consoleInvocationDatabases.get(invocations)
  if (!database) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0064({ message: "[vitehub] The Agent invocation console is not backed by the Console Drizzle database." })
  }
  return await database()
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

interface ConsoleDatabaseOptions {
  authToken?: string
  url: string
}

/** Workers have no file system, and the libsql Web client rejects `file:` URLs. */
function isWorkersRuntime(): boolean {
  const navigator: unknown = Reflect.get(globalThis, "navigator")
  return typeof navigator === "object" && navigator !== null && Reflect.get(navigator, "userAgent") === "Cloudflare-Workers"
}

function processEnvironment(): NodeJS.ProcessEnv | undefined {
  return globalThis.process?.env
}

export function resolveConsoleDatabaseOptions(projectRoot: string, databaseUrl?: string): ConsoleDatabaseOptions {
  const environment = processEnvironment()
  const configuredUrl = environment?.VITEHUB_CONSOLE_DATABASE_URL?.trim()
  const url = configuredUrl || databaseUrl || `file:${resolve(projectRoot, ".vitehub/data/console.sqlite")}`
  const authToken = environment?.VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN
  if (!/^file:/i.test(url)) {
    const options: ConsoleDatabaseOptions = { url }
    if (authToken) options.authToken = authToken
    return options
  }
  // Workers cannot create the journal directory. `createConsoleInvocations` keeps the journal in memory there.
  if (isWorkersRuntime()) return { url }

  const fragmentIndex = url.indexOf("#")
  const urlWithoutFragment = fragmentIndex === -1 ? url : url.slice(0, fragmentIndex)
  const queryIndex = urlWithoutFragment.indexOf("?")
  const fileUrl = queryIndex === -1 ? urlWithoutFragment : urlWithoutFragment.slice(0, queryIndex)
  const query = queryIndex === -1 ? "" : urlWithoutFragment.slice(queryIndex)
  const isAbsoluteFileUrl = /^file:\//i.test(fileUrl)
  const relativeFilePath = isAbsoluteFileUrl
    ? undefined
    : decodeURIComponent(fileUrl.slice("file:".length))
  if (relativeFilePath === ":memory:") return { url: urlWithoutFragment }
  const filePath = isAbsoluteFileUrl
    ? fileURLToPath(fileUrl)
    : resolve(projectRoot, relativeFilePath!)
  mkdirSync(dirname(filePath), { recursive: true })
  return { url: `${pathToFileURL(filePath).href}${query}` }
}

/** The Worker env binding that stores the Console journal on Cloudflare. */
export interface ConsoleD1Journal {
  binding: string
  env: () => Promise<Record<string, unknown>> | Record<string, unknown>
}

function isD1Database(value: unknown): value is ConsoleD1Database {
  if (typeof value !== "object" || value === null || !("prepare" in value) || typeof value.prepare !== "function" || !("batch" in value) || typeof value.batch !== "function") return false
  const statement: unknown = value.prepare("SELECT 1")
  return typeof statement === "object" && statement !== null && "raw" in statement && typeof statement.raw === "function"
}

/** Console journal in the app's D1 database. The store creates its table on first use and keeps its default retention. */
export function createConsoleD1Invocations(d1: ConsoleD1Journal, observations?: AgentInvocationsOptions["observations"], retention?: AgentRetentionPolicy): AgentInvocations {
  const { maxSize, ...limits } = retention ?? {}
  if (maxSize !== undefined && maxSize !== false) throw consoleD1MaxSizeError()
  // Check the limits now, so a bad limit fails when the server starts, not on the first invocation.
  d1AgentInvocationRetention(limits)
  // The D1 store code loads on the first read or write, not at server start. A module import is not request I/O, so
  // concurrent first uses share it. A failed import tries again on the next use.
  let d1Store: Promise<typeof import("@vite-hub/agent/invocations/d1")> | undefined
  const loadD1 = () => d1Store ??= import("@vite-hub/agent/invocations/d1").catch((error: unknown) => {
    d1Store = undefined
    throw error
  })
  // Keep only completed initialization; Worker requests cannot share pending I/O.
  const migrated = new WeakSet<ConsoleD1Database>()
  const database = async () => {
    const binding = (await d1.env())[d1.binding]
    if (!isD1Database(binding)) {
      throw viteHubErrorDiagnostics.VITE_HUB_R0122({ message: `[vitehub] The Console journal requires the D1 binding ${JSON.stringify(d1.binding)} in the Worker env. Configure the Database D1 binding or set console.databaseUrl.` })
    }
    if (!migrated.has(binding)) {
      const { d1AgentInvocationSchema } = await loadD1()
      await binding.batch(d1AgentInvocationSchema().map(statement => binding.prepare(statement)))
      migrated.add(binding)
    }
    return binding
  }
  let store: Required<AgentInvocationStore> | undefined
  const invocations = defineAgentInvocations({
    configuration: "content",
    metadataContent: consoleMetadataContent,
    observations,
    store: lazyAgentInvocationStore(async () => store ??= (await loadD1()).createD1AgentInvocationStore({ database, migrate: false, ...limits })),
  })
  let drizzleDatabase: Promise<ConsoleInvocationsDatabase> | undefined
  consoleInvocationDatabases.set(invocations, () => drizzleDatabase ??= import("./invocations-database.ts").then(module => module.createConsoleD1Database(database)))
  const indexes = new WeakMap<ConsoleD1Database, ReturnType<typeof createConsoleUsageIndex>>()
  const usageIndex = async () => {
    const binding = await database()
    const { createConsoleUsageIndex } = await import("./usage-index.ts")
    let index = indexes.get(binding)
    if (!index) {
      const prepare = (statement: Parameters<ConsoleUsageClient["execute"]>[0]) =>
        binding.prepare(statement.sql).bind(...(statement.args ?? []))
      const client: ConsoleUsageClient = {
        async execute(statement) {
          const result = await prepare(statement).all<Record<string, Value>>()
          return { rows: result.results ?? [] }
        },
        async batch(statements) {
          const results = await binding.batch<Record<string, Value>>(statements.map(prepare))
          return results.map((result) => ({ rows: result.results ?? [] }))
        },
      }
      index = createConsoleUsageIndex(client, { requestScoped: true })
      indexes.set(binding, index)
    }
    return index
  }
  consoleUsageIndexes.set(invocations, {
    async query(options) {
      return (await usageIndex()).query(options)
    },
    async rebuild() {
      await (await usageIndex()).rebuild()
    },
  })
  consoleDatabaseConfigurations.set(invocations, `d1:${d1.binding}`)
  consoleObservationConfigurations.set(invocations, observationConfiguration(observations, retention))
  return invocations
}

/** Console journals keep every terminal record unless `retention` sets a limit. */
export function createConsoleInvocations(projectRoot: string, observations?: AgentInvocationsOptions["observations"], databaseUrl?: string, retention?: AgentRetentionPolicy): AgentInvocations {
  const database = resolveConsoleDatabaseOptions(projectRoot, databaseUrl)
  if (/^file:/i.test(database.url) && isWorkersRuntime()) {
    // A Worker without a D1 binding or a remote URL has no durable journal. Keep it in memory instead of failing at startup.
    const invocations = defineAgentInvocations({ configuration: "content", metadataContent: consoleMetadataContent, observations, store: createMemoryAgentInvocationStore() })
    consoleDatabaseConfigurations.set(invocations, database.url)
    consoleObservationConfigurations.set(invocations, observationConfiguration(observations, retention))
    return invocations
  }
  // libSQL and Drizzle load on the first read or write, not at server start. Concurrent first uses share one open.
  let journal: Promise<ConsoleLibsqlJournal> | undefined
  const open = () => journal ??= import("./invocations-database.ts")
    .then(module => module.openConsoleLibsqlJournal(database, retention))
    .catch((error: unknown) => {
      // Let the next use try again.
      journal = undefined
      throw error
    })
  const invocations = defineAgentInvocations({
    configuration: "content",
    metadataContent: consoleMetadataContent,
    observations,
    store: lazyAgentInvocationStore(async () => (await open()).store),
  })
  consoleDatabaseConfigurations.set(invocations, database.url)
  consoleObservationConfigurations.set(invocations, observationConfiguration(observations, retention))
  consoleUsageIndexes.set(invocations, {
    async query(options) {
      return (await open()).usageIndex.query(options)
    },
    async rebuild() {
      await (await open()).usageIndex.rebuild()
    },
  })
  consoleInvocationDatabases.set(invocations, async () => (await open()).database)
  return invocations
}

export function installConsoleInvocations(
  projectRoot: string,
  configuredInvocations?: AgentInvocations,
  observations?: AgentInvocationsOptions["observations"],
  databaseUrl?: string,
  d1?: ConsoleD1Journal,
  retention?: AgentRetentionPolicy,
): AgentInvocations {
  const resolvedRoot = resolve(projectRoot)
  const identity = createConsoleInvocationsIdentity(resolvedRoot)
  const installed = resolveConsoleInvocations()
  const installedConfiguration = installed && consoleObservationConfigurations.get(installed)
  const sameConfiguration = installedConfiguration === undefined
    ? observations === undefined && retention === undefined
    : installedConfiguration === observationConfiguration(observations, retention)
  // VITEHUB_CONSOLE_DATABASE_URL still selects libSQL at runtime.
  const useD1 = d1 !== undefined && !processEnvironment()?.VITEHUB_CONSOLE_DATABASE_URL?.trim()
  const databaseConfiguration = () => useD1 ? `d1:${d1.binding}` : resolveConsoleDatabaseOptions(resolvedRoot, databaseUrl).url
  if (installed && resolveConsoleInvocationsIdentity() === identity && (configuredInvocations ? installed === configuredInvocations : sameConfiguration && consoleDatabaseConfigurations.get(installed) === databaseConfiguration())) return installed
  const invocations = configuredInvocations ?? (useD1 ? createConsoleD1Invocations(d1, observations, retention) : createConsoleInvocations(resolvedRoot, observations, databaseUrl, retention))
  installConsoleInvocationFallback(invocations, resolvedRoot, globalThis, identity)
  return invocations
}
