import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createClient } from "@libsql/client"
import { createD1AgentInvocationStore, d1AgentInvocationSchema } from "@vite-hub/agent/invocations/d1"
import { createLibsqlAgentInvocationStore } from "@vite-hub/agent/invocations/sqlite"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { drizzle as drizzleRemote } from "drizzle-orm/sqlite-proxy"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

import { createConsoleUsageIndex } from "./usage-index.ts"

import {
  createConsoleInvocationsIdentity,
  installConsoleInvocationFallback,
  resolveConsoleInvocations,
  resolveConsoleInvocationsByIdentity,
  resolveConsoleInvocationsIdentity,
  resolveConsoleInvocationsRevision,
} from "../../internal.ts"
import { consoleFixtureRevision, readConsoleFixture } from "../../fixture.ts"

import type { Value } from "@libsql/client"
import type { ConsoleUsageClient } from "./usage-index.ts"
import type { AgentInvocationRecord, AgentInvocationSummary, AgentInvocations } from "@vite-hub/agent"
import type { AgentInvocationD1Database, AgentInvocationD1Statement } from "@vite-hub/agent/invocations/d1"
import type { AgentInvocationsOptions } from "@vite-hub/agent/server"
import type { ConsoleFixture } from "../../fixture.ts"
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy"
import type { LibSQLDatabase } from "drizzle-orm/libsql"
import type { AnySQLiteColumn, SQLiteTableWithColumns } from "drizzle-orm/sqlite-core"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

const consoleMetadataContent = [
  "channel.effect.content",
  "input.messages",
  "input.prompt",
  "message.content",
  "result.text",
  "tool.input",
  "tool.output",
  "vitehub.activity.progress",
  "vitehub.session.title",
] as const

type ConsoleInvocationColumn<Data, NotNull extends boolean, HasDefault extends boolean = false> = AnySQLiteColumn<{
  data: Data
  hasDefault: HasDefault
  notNull: NotNull
  tableName: "vitehub_agent_invocations"
}> & { _: { generated: undefined } }

type ConsoleInvocationsTable<Nullable extends boolean> = SQLiteTableWithColumns<{
  columns: {
    agentName: ConsoleInvocationColumn<string, true, true>
    id: ConsoleInvocationColumn<string, true>
    record: ConsoleInvocationColumn<Omit<AgentInvocationRecord, "cursor">, true>
    search: ConsoleInvocationColumn<string, Nullable extends true ? false : true>
    sequence: ConsoleInvocationColumn<number, true, true>
    status: ConsoleInvocationColumn<string, true>
    summary: ConsoleInvocationColumn<Omit<AgentInvocationSummary, "cursor">, Nullable extends true ? false : true>
    updatedAt: ConsoleInvocationColumn<string, true, true>
  }
  dialect: "sqlite"
  name: "vitehub_agent_invocations"
  schema: undefined
}>

// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Drizzle's inferred table type cannot be emitted under isolatedDeclarations, so keep the public schema explicit here.
// SAFETY: The explicit table type mirrors the libSQL journal columns constructed immediately below.
const consoleInvocationsTable = sqliteTable("vitehub_agent_invocations", {
  sequence: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull().unique(),
  status: text().notNull(),
  agentName: text("agent_name").notNull().default(""),
  search: text(),
  summary: text({ mode: "json" }).$type<Omit<AgentInvocationSummary, "cursor">>(),
  updatedAt: text("updated_at").notNull().default(""),
  record: text({ mode: "json" }).$type<Omit<AgentInvocationRecord, "cursor">>().notNull(),
}) as unknown as ConsoleInvocationsTable<true>

// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Drizzle's inferred table type cannot be emitted under isolatedDeclarations, so keep the public schema explicit here.
// SAFETY: The explicit table type mirrors the D1 journal columns constructed immediately below.
const consoleD1InvocationsTable = sqliteTable("vitehub_agent_invocations", {
  sequence: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull().unique(),
  status: text().notNull(),
  agentName: text("agent_name").notNull().default(""),
  search: text().notNull(),
  summary: text({ mode: "json" }).$type<Omit<AgentInvocationSummary, "cursor">>().notNull(),
  updatedAt: text("updated_at").notNull().default(""),
  record: text({ mode: "json" }).$type<Omit<AgentInvocationRecord, "cursor">>().notNull(),
}) as unknown as ConsoleInvocationsTable<false>

const consoleInvocationSchema: { invocations: typeof consoleInvocationsTable } = {
  invocations: consoleInvocationsTable,
}
const consoleD1InvocationSchema: { invocations: typeof consoleD1InvocationsTable } = {
  invocations: consoleD1InvocationsTable,
}

export type ConsoleInvocationsDatabase = {
  driver: "libsql"
  db: LibSQLDatabase<typeof consoleInvocationSchema>
  schema: typeof consoleInvocationSchema
} | {
  driver: "d1"
  db: SqliteRemoteDatabase<typeof consoleD1InvocationSchema>
  schema: typeof consoleD1InvocationSchema
}

const consoleUsageIndexes = new WeakMap<AgentInvocations, ReturnType<typeof createConsoleUsageIndex>>()

export function getConsoleUsageIndex(invocations: AgentInvocations): ReturnType<typeof createConsoleUsageIndex> | undefined {
  return consoleUsageIndexes.get(invocations)
}

const consoleInvocationDatabases = new WeakMap<AgentInvocations, ConsoleInvocationsDatabase>()
const consoleDatabaseConfigurations = new WeakMap<AgentInvocations, string>()
const consoleObservationConfigurations = new WeakMap<AgentInvocations, string>()

function observationConfiguration(observations: AgentInvocationsOptions["observations"]): string {
  return JSON.stringify(observations, ["maxCount", "maxStringLength", "maxBytes", "flushTimeoutMs"]) ?? "undefined"
}

export function getConsoleInvocations(): AgentInvocations {
  const invocations = resolveConsoleInvocations()
  if (!invocations) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0063({ message: "[vitehub] The Agent invocation console has not been installed for this runtime." })
  }
  return invocations
}

export function getConsoleInvocationsDatabase(): ConsoleInvocationsDatabase {
  const invocations = getConsoleInvocations()
  const database = consoleInvocationDatabases.get(invocations)
  if (!database) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0064({ message: "[vitehub] The Agent invocation console is not backed by the Console Drizzle database." })
  }
  return database
}

interface ConsoleDatabaseOptions {
  authToken?: string
  url: string
}

export function resolveConsoleDatabaseOptions(projectRoot: string, databaseUrl?: string): ConsoleDatabaseOptions {
  const configuredUrl = process.env.VITEHUB_CONSOLE_DATABASE_URL?.trim()
  const url = configuredUrl || databaseUrl || `file:${resolve(projectRoot, ".vitehub/data/console.sqlite")}`
  const authToken = process.env.VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN
  if (!/^file:/i.test(url)) {
    const options: ConsoleDatabaseOptions = { url }
    if (authToken) options.authToken = authToken
    return options
  }

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

interface ConsoleD1Statement extends AgentInvocationD1Statement {
  bind(...values: unknown[]): ConsoleD1Statement
  raw(): Promise<unknown[][]>
}

interface ConsoleD1Database extends AgentInvocationD1Database {
  prepare(query: string): ConsoleD1Statement
}

function isD1Database(value: unknown): value is ConsoleD1Database {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The Worker env is untyped, so check the D1 methods that the journal calls.
  if (typeof value !== "object" || value === null || !("prepare" in value) || typeof value.prepare !== "function" || !("batch" in value) || typeof value.batch !== "function") return false
  const statement: unknown = value.prepare("SELECT 1")
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console Drizzle reads positional rows through D1's raw statement operation.
  return typeof statement === "object" && statement !== null && "raw" in statement && typeof statement.raw === "function"
}

/** Console journal in the app's D1 database. The store creates its table on first use and keeps its default retention. */
export function createConsoleD1Invocations(d1: ConsoleD1Journal, observations?: AgentInvocationsOptions["observations"]): AgentInvocations {
  // Keep only completed initialization; Worker requests cannot share pending I/O.
  const migrated = new WeakSet<AgentInvocationD1Database>()
  const database = async () => {
    const binding = (await d1.env())[d1.binding]
    if (!isD1Database(binding)) {
      throw viteHubErrorDiagnostics.VITE_HUB_R0122({ message: `[vitehub] The Console journal requires the D1 binding ${JSON.stringify(d1.binding)} in the Worker env. Configure the Database D1 binding or set console.databaseUrl.` })
    }
    if (!migrated.has(binding)) {
      await binding.batch(d1AgentInvocationSchema().map(statement => binding.prepare(statement)))
      migrated.add(binding)
    }
    return binding
  }
  const invocations = defineAgentInvocations({
    configuration: "content",
    metadataContent: consoleMetadataContent,
    observations,
    store: createD1AgentInvocationStore({ database, migrate: false }),
  })
  const db = drizzleRemote(async (query, parameters, method) => {
    const binding = await database()
    const statement = binding.prepare(query).bind(...parameters)
    const rows = await statement.raw()
    return { rows: method === "get" ? rows[0]! : rows }
  }, async (queries) => {
    const binding = await database()
    const results = await binding.batch(queries.map(query => binding.prepare(query.sql).bind(...query.params)))
    return results.map((result, index) => {
      const rows = (result.results ?? []).map(row => Object.values(row))
      return { rows: queries[index]!.method === "get" ? rows[0]! : rows }
    })
  }, { schema: consoleD1InvocationSchema })
  // D1 cannot keep Drizzle's separate BEGIN/query/COMMIT calls in one transaction.
  db.transaction = async () => {
    throw viteHubErrorDiagnostics.VITE_HUB_R0123({ message: "[vitehub] The D1 Console journal does not support db.transaction(). Use db.batch() for atomic writes." })
  }
  consoleInvocationDatabases.set(invocations, {
    driver: "d1",
    db,
    schema: consoleD1InvocationSchema,
  })
  const indexes = new WeakMap<ConsoleD1Database, ReturnType<typeof createConsoleUsageIndex>>()
  const usageIndex = async () => {
    const binding = await database()
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
  consoleObservationConfigurations.set(invocations, observationConfiguration(observations))
  return invocations
}

export function createConsoleInvocations(projectRoot: string, observations?: AgentInvocationsOptions["observations"], databaseUrl?: string): AgentInvocations {
  const database = resolveConsoleDatabaseOptions(projectRoot, databaseUrl)
  const client = createClient(database)
  let invocations: AgentInvocations
  try {
    invocations = defineAgentInvocations({
      configuration: "content",
      metadataContent: consoleMetadataContent,
      observations,
      store: createLibsqlAgentInvocationStore({
        client,
        maxAgeMs: false,
        maxRecords: false,
      }),
    })
  }
  catch (error) {
    client.close()
    throw error
  }
  consoleDatabaseConfigurations.set(invocations, database.url)
  consoleObservationConfigurations.set(invocations, observationConfiguration(observations))
  consoleUsageIndexes.set(invocations, createConsoleUsageIndex(client))
  consoleInvocationDatabases.set(invocations, {
    driver: "libsql",
    db: drizzle(client, { schema: consoleInvocationSchema }),
    schema: consoleInvocationSchema,
  })
  return invocations
}

function createConsoleFixtureInvocationsFromSnapshot(fixture: ConsoleFixture): AgentInvocations {
  const store = createMemoryAgentInvocationStore()
  for (const record of fixture.invocations) {
    const { cursor: _cursor, ...input } = record
    store.create(input)
  }
  return defineAgentInvocations({ configuration: "content", metadataContent: consoleMetadataContent, store })
}

export function createConsoleFixtureInvocations(file: string): AgentInvocations {
  return createConsoleFixtureInvocationsFromSnapshot(readConsoleFixture(file))
}

export function installConsoleInvocations(
  projectRoot: string,
  configuredInvocations?: AgentInvocations,
  observations?: AgentInvocationsOptions["observations"],
  databaseUrl?: string,
  d1?: ConsoleD1Journal,
): AgentInvocations {
  const resolvedRoot = resolve(projectRoot)
  const identity = createConsoleInvocationsIdentity(resolvedRoot)
  const installed = resolveConsoleInvocations()
  const installedConfiguration = installed && consoleObservationConfigurations.get(installed)
  const sameConfiguration = installedConfiguration === undefined
    ? observations === undefined
    : installedConfiguration === observationConfiguration(observations)
  // VITEHUB_CONSOLE_DATABASE_URL still selects libSQL at runtime.
  const useD1 = d1 !== undefined && !process.env.VITEHUB_CONSOLE_DATABASE_URL?.trim()
  const databaseConfiguration = () => useD1 ? `d1:${d1.binding}` : resolveConsoleDatabaseOptions(resolvedRoot, databaseUrl).url
  if (installed && resolveConsoleInvocationsIdentity() === identity && (configuredInvocations ? installed === configuredInvocations : sameConfiguration && consoleDatabaseConfigurations.get(installed) === databaseConfiguration())) return installed
  const invocations = configuredInvocations ?? (useD1 ? createConsoleD1Invocations(d1, observations) : createConsoleInvocations(resolvedRoot, observations, databaseUrl))
  installConsoleInvocationFallback(invocations, resolvedRoot, globalThis, identity)
  return invocations
}

export function installConsoleFixtureInvocations(
  projectRoot: string,
  file: string,
  generatedFixture?: ConsoleFixture,
  generatedRevision?: string,
  runtimeBinding?: string,
): AgentInvocations {
  const resolvedRoot = resolve(projectRoot)
  const resolvedFile = resolve(file)
  const fixture = generatedFixture ?? readConsoleFixture(resolvedFile)
  const revision = generatedRevision ?? consoleFixtureRevision(fixture)
  const identity = createConsoleInvocationsIdentity(resolvedRoot, resolvedFile, revision, runtimeBinding)
  const installed = resolveConsoleInvocationsByIdentity(identity)
  if (installed && resolveConsoleInvocationsRevision(identity) === revision) {
    installConsoleInvocationFallback(installed, resolvedRoot, globalThis, identity, revision)
    return installed
  }
  const invocations = createConsoleFixtureInvocationsFromSnapshot(fixture)
  installConsoleInvocationFallback(invocations, resolvedRoot, globalThis, identity, revision)
  return invocations
}
