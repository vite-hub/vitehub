import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createClient } from "@libsql/client"
import { createLibsqlAgentInvocationStore } from "@vite-hub/agent/invocations/sqlite"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

import {
  createConsoleInvocationsIdentity,
  installConsoleInvocationFallback,
  resolveConsoleInvocations,
  resolveConsoleInvocationsByIdentity,
  resolveConsoleInvocationsIdentity,
  resolveConsoleInvocationsRevision,
} from "../../internal.ts"
import { consoleFixtureRevision, readConsoleFixture } from "../../fixture.ts"

import type { AgentInvocationRecord, AgentInvocationSummary, AgentInvocations } from "@vite-hub/agent"
import type { AgentInvocationsOptions } from "@vite-hub/agent/server"
import type { ConsoleFixture } from "../../fixture.ts"
import type { LibSQLDatabase } from "drizzle-orm/libsql"
import type { AnySQLiteColumn, SQLiteTableWithColumns } from "drizzle-orm/sqlite-core"

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

type ConsoleInvocationColumn<Data, NotNull extends boolean> = AnySQLiteColumn<{
  data: Data
  notNull: NotNull
  tableName: "vitehub_agent_invocations"
}>

type ConsoleInvocationsTable = SQLiteTableWithColumns<{
  columns: {
    agentName: ConsoleInvocationColumn<string, true>
    id: ConsoleInvocationColumn<string, true>
    record: ConsoleInvocationColumn<Omit<AgentInvocationRecord, "cursor">, true>
    search: ConsoleInvocationColumn<string, false>
    searchVersion: ConsoleInvocationColumn<number, true>
    sequence: ConsoleInvocationColumn<number, true>
    status: ConsoleInvocationColumn<string, true>
    summary: ConsoleInvocationColumn<AgentInvocationSummary, false>
    updatedAt: ConsoleInvocationColumn<string, true>
  }
  dialect: "sqlite"
  name: "vitehub_agent_invocations"
  schema: undefined
}>

// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Drizzle's inferred table type cannot be emitted under isolatedDeclarations, so keep the public schema explicit here.
// SAFETY: The explicit table type mirrors every column constructed immediately below.
const consoleInvocationsTable = sqliteTable("vitehub_agent_invocations", {
  sequence: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull().unique(),
  status: text().notNull(),
  agentName: text("agent_name").notNull().default(""),
  search: text(),
  searchVersion: integer("search_version").notNull().default(0),
  summary: text({ mode: "json" }).$type<AgentInvocationSummary>(),
  updatedAt: text("updated_at").notNull().default(""),
  record: text({ mode: "json" }).$type<Omit<AgentInvocationRecord, "cursor">>().notNull(),
}) as unknown as ConsoleInvocationsTable

const consoleInvocationSchema: { invocations: typeof consoleInvocationsTable } = {
  invocations: consoleInvocationsTable,
}

export interface ConsoleInvocationsDatabase {
  db: LibSQLDatabase<typeof consoleInvocationSchema>
  schema: typeof consoleInvocationSchema
}

const consoleInvocationDatabases = new WeakMap<AgentInvocations, ConsoleInvocationsDatabase>()
const consoleObservationConfigurations = new WeakMap<AgentInvocations, string>()

function observationConfiguration(observations: AgentInvocationsOptions["observations"]): string {
  return JSON.stringify(observations, ["maxCount", "maxStringLength", "maxBytes", "flushTimeoutMs"]) ?? "undefined"
}

export function getConsoleInvocations(): AgentInvocations {
  const invocations = resolveConsoleInvocations()
  if (!invocations) {
    throw new TypeError("[vitehub] The Agent invocation console has not been installed for this runtime.")
  }
  return invocations
}

export function getConsoleInvocationsDatabase(): ConsoleInvocationsDatabase {
  const invocations = getConsoleInvocations()
  const database = consoleInvocationDatabases.get(invocations)
  if (!database) {
    throw new TypeError("[vitehub] The Agent invocation console is not backed by the Console Drizzle database.")
  }
  return database
}

interface ConsoleDatabaseOptions {
  authToken?: string
  url: string
}

export function resolveConsoleDatabaseOptions(projectRoot: string): ConsoleDatabaseOptions {
  const configuredUrl = process.env.VITEHUB_CONSOLE_DATABASE_URL?.trim()
  const url = configuredUrl || `file:${resolve(projectRoot, ".vitehub/data/console.sqlite")}`
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

export function createConsoleInvocations(projectRoot: string, observations?: AgentInvocationsOptions["observations"]): AgentInvocations {
  const client = createClient(resolveConsoleDatabaseOptions(projectRoot))
  let invocations: AgentInvocations
  try {
    invocations = defineAgentInvocations({
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
  consoleObservationConfigurations.set(invocations, observationConfiguration(observations))
  consoleInvocationDatabases.set(invocations, {
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
  return defineAgentInvocations({ metadataContent: consoleMetadataContent, store })
}

export function createConsoleFixtureInvocations(file: string): AgentInvocations {
  return createConsoleFixtureInvocationsFromSnapshot(readConsoleFixture(file))
}

export function installConsoleInvocations(
  projectRoot: string,
  configuredInvocations?: AgentInvocations,
  observations?: AgentInvocationsOptions["observations"],
): AgentInvocations {
  const resolvedRoot = resolve(projectRoot)
  const identity = createConsoleInvocationsIdentity(resolvedRoot)
  const installed = resolveConsoleInvocations()
  const installedConfiguration = installed && consoleObservationConfigurations.get(installed)
  const sameConfiguration = installedConfiguration === undefined
    ? observations === undefined
    : installedConfiguration === observationConfiguration(observations)
  if (installed && resolveConsoleInvocationsIdentity() === identity && (configuredInvocations ? installed === configuredInvocations : sameConfiguration)) return installed
  const invocations = configuredInvocations ?? createConsoleInvocations(resolvedRoot, observations)
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
