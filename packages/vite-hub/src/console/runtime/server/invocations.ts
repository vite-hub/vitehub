import { resolve } from "node:path"

import { defaultAgentInvocationsDatabase, defaultAgentInvocationsMetadataContent } from "@vite-hub/agent/invocations/default"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"

import { createConsoleUsageIndex } from "./usage-index.ts"

import {
  createConsoleInvocationsIdentity,
  installConsoleInvocationFallback,
  markConsoleFixtureInvocations,
  resolveConsoleInvocations,
  resolveConsoleInvocationsByIdentity,
  resolveConsoleInvocationsIdentity,
  resolveConsoleInvocationsRevision,
} from "../../internal.ts"
import { resolveDefaultAgentInvocations } from "../../../_internal/agent/invocations.ts"
import { consoleFixtureRevision, readConsoleFixture } from "../../fixture.ts"

import type { Value } from "@libsql/client"
import type { DefaultAgentInvocationsD1Database } from "@vite-hub/agent/invocations/default"
import type { ConsoleUsageClient } from "./usage-index.ts"
import type { AgentInvocations } from "@vite-hub/agent"
import type { ConsoleFixture } from "../../fixture.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

type ConsoleUsageIndex = ReturnType<typeof createConsoleUsageIndex>

const consoleUsageIndexes = new WeakMap<AgentInvocations, ConsoleUsageIndex | undefined>()

function d1UsageClient(binding: DefaultAgentInvocationsD1Database): ConsoleUsageClient {
  const prepare = (statement: Parameters<ConsoleUsageClient["execute"]>[0]) =>
    binding.prepare(statement.sql).bind(...(statement.args ?? []))
  return {
    async execute(statement) {
      const result = await prepare(statement).all<Record<string, Value>>()
      return { rows: result.results ?? [] }
    },
    async batch(statements) {
      const results = await binding.batch<Record<string, Value>>(statements.map(prepare))
      return results.map(result => ({ rows: result.results ?? [] }))
    },
  }
}

/** The usage projection over the database of the default Agent journal. Other journals have none. */
function createUsageIndex(invocations: AgentInvocations): ConsoleUsageIndex | undefined {
  const database = defaultAgentInvocationsDatabase(invocations)
  if (!database) return undefined
  if (database.driver === "libsql") {
    let index: Promise<ConsoleUsageIndex> | undefined
    const open = () => index ??= database.open().then(client => createConsoleUsageIndex(client)).catch((error: unknown) => {
      // Let the next read try again.
      index = undefined
      throw error
    })
    return {
      async query(options) {
        return (await open()).query(options)
      },
      async rebuild() {
        await (await open()).rebuild()
      },
    }
  }
  // Each Worker request resolves its own D1 binding, so keep one index per binding.
  const indexes = new WeakMap<DefaultAgentInvocationsD1Database, ConsoleUsageIndex>()
  const open = async () => {
    const binding = await database.open()
    let index = indexes.get(binding)
    if (!index) {
      index = createConsoleUsageIndex(d1UsageClient(binding), { requestScoped: true })
      indexes.set(binding, index)
    }
    return index
  }
  return {
    async query(options) {
      return (await open()).query(options)
    },
    async rebuild() {
      await (await open()).rebuild()
    },
  }
}

export function getConsoleUsageIndex(invocations: AgentInvocations): ConsoleUsageIndex | undefined {
  if (!consoleUsageIndexes.has(invocations)) consoleUsageIndexes.set(invocations, createUsageIndex(invocations))
  return consoleUsageIndexes.get(invocations)
}

export function getConsoleInvocations(): AgentInvocations {
  const invocations = resolveConsoleInvocations()
  if (!invocations) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0063({ message: "[vitehub] The Agent invocation console has not been installed for this runtime." })
  }
  return invocations
}

// The Console reads a journal even when `agent.invocations` is false. This one stays empty.
const emptyJournals = new WeakSet<AgentInvocations>()

/**
 * Registers the journal that the Console reads: `configuredInvocations`, else the app-wide Agent journal.
 * The Console does not create a durable journal. With `agent.invocations: false`, it reads an empty memory journal.
 */
export function installConsoleInvocations(projectRoot: string, configuredInvocations?: AgentInvocations): AgentInvocations {
  const resolvedRoot = resolve(projectRoot)
  const identity = createConsoleInvocationsIdentity(resolvedRoot)
  const installed = resolveConsoleInvocations()
  const sameRoot = installed !== undefined && resolveConsoleInvocationsIdentity() === identity
  const target = configuredInvocations ?? resolveDefaultAgentInvocations()
  if (sameRoot && (target ? installed === target : emptyJournals.has(installed))) return installed
  let invocations = target
  if (!invocations) {
    invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    emptyJournals.add(invocations)
  }
  installConsoleInvocationFallback(invocations, resolvedRoot, globalThis, identity)
  return invocations
}

function createConsoleFixtureInvocationsFromSnapshot(fixture: ConsoleFixture): AgentInvocations {
  const store = createMemoryAgentInvocationStore()
  for (const record of fixture.invocations) {
    const { cursor: _cursor, ...input } = record
    store.create(input)
  }
  const invocations = defineAgentInvocations({ configuration: "content", metadataContent: defaultAgentInvocationsMetadataContent, store })
  markConsoleFixtureInvocations(invocations)
  return invocations
}

export function createConsoleFixtureInvocations(file: string): AgentInvocations {
  return createConsoleFixtureInvocationsFromSnapshot(readConsoleFixture(file))
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
