import { defaultAgentInvocationsDatabase } from "@vite-hub/agent/internal/default-invocations-core"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"

import { consoleState, resolveConsoleInvocations } from "../../internal.ts"
import { resolveDefaultAgentInvocations } from "@vite-hub/agent/invocations/app"

import type { Value } from "@libsql/client"
import type { DefaultAgentInvocationsD1Database } from "@vite-hub/agent/internal/default-invocations-core"
import type { AgentUsagePeriod, AgentUsageQuery, AgentUsageSqlClient, AgentUsageSummary } from "@vite-hub/agent/usage"
import type { AgentInvocations } from "@vite-hub/agent"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

function d1SqlClient(binding: DefaultAgentInvocationsD1Database): AgentUsageSqlClient {
  return {
    async execute(statement) {
      const result = await binding.prepare(statement.sql).bind(...statement.args).all<Record<string, Value>>()
      return { rows: result.results ?? [] }
    },
  }
}

/**
 * Usage of the default Agent journal, added up by its database in one statement. Undefined for other journals.
 * It reads the journal tables and writes nothing.
 */
export async function readConsoleJournalUsage(invocations: AgentInvocations, query: AgentUsageQuery, period: AgentUsagePeriod): Promise<AgentUsageSummary | undefined> {
  const database = defaultAgentInvocationsDatabase(invocations)
  if (!database) return undefined
  const [{ readAgentUsage }, client] = await Promise.all([
    import("@vite-hub/agent/usage"),
    database.driver === "libsql" ? database.open() : database.open().then(d1SqlClient),
  ])
  return await readAgentUsage(client, query, period)
}

export function getConsoleInvocations(): AgentInvocations {
  const invocations = resolveConsoleInvocations()
  if (!invocations) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0063({ message: "[vitehub] This app has no Agent Invocation journal for the Console to read. The Console is off, or the app has no Agent Definition." })
  }
  return invocations
}

// The Console reads a journal even when `agent.invocations` is false. This one stays empty.
const emptyJournals = new WeakSet<AgentInvocations>()

/**
 * Registers the journal that the Console reads: `configuredInvocations`, else the app-wide Agent journal.
 * The Console does not create a durable journal. With `agent.invocations: false`, it reads an empty memory journal.
 * One server bundle serves one project, so the Console keeps one journal in its state, like its sections.
 */
export function installConsoleInvocations(projectRoot: string, configuredInvocations?: AgentInvocations): AgentInvocations {
  const state = consoleState()
  const installed = state.invocations
  const target = configuredInvocations ?? resolveDefaultAgentInvocations()
  if (installed && (target ? installed === target : emptyJournals.has(installed))) return installed
  let invocations = target
  if (!invocations) {
    invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    emptyJournals.add(invocations)
  }
  return state.invocations = invocations
}
