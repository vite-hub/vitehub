import { defaultAgentInvocationsDatabase } from "@vite-hub/agent/invocations/default"

import { resolveDefaultAgentInvocations } from "../../_internal/agent/invocations.ts"
import { viteHubErrorDiagnostics } from "../../error-diagnostics.ts"

import type { AgentInvocations } from "@vite-hub/agent"
import type { AgentInvocationsDatabase } from "./journal-database.ts"

export type { AgentInvocationsDatabase } from "./journal-database.ts"

const drizzleDatabases = new WeakMap<AgentInvocations, Promise<AgentInvocationsDatabase | undefined>>()

async function openDrizzleDatabase(invocations: AgentInvocations): Promise<AgentInvocationsDatabase | undefined> {
  const database = defaultAgentInvocationsDatabase(invocations)
  if (!database) return undefined
  const { createD1InvocationsDatabase, createLibsqlInvocationsDatabase } = await import("./journal-database.ts")
  return database.driver === "libsql"
    ? createLibsqlInvocationsDatabase(await database.open())
    : createD1InvocationsDatabase(database.open)
}

/**
 * The app-wide Agent Invocation journal: the default journal, or the `agent.invocations` store.
 * Agents that set no `invocations` record here, and the Console reads it.
 */
export function getAgentInvocations(): AgentInvocations {
  const invocations = resolveDefaultAgentInvocations()
  if (!invocations) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0140({ message: "[vitehub] No app-wide Agent Invocation journal is installed. Call getAgentInvocations() in the ViteHub server of an app with Agents, and do not set agent.invocations to false." })
  }
  return invocations
}

/**
 * Opens Drizzle over the default journal on first use, for queries and `db.batch()` writes.
 * Resolves to `undefined` when `agent.invocations` selects another store or `false`, and for the memory journal of a
 * Worker without D1 or a remote libSQL URL.
 */
export async function getAgentInvocationsDatabase(): Promise<AgentInvocationsDatabase | undefined> {
  const invocations = resolveDefaultAgentInvocations()
  if (!invocations) return undefined
  // Concurrent first calls share one open. A failed open lets the next call try again.
  let database = drizzleDatabases.get(invocations)
  if (!database) {
    database = openDrizzleDatabase(invocations).catch((error: unknown) => {
      drizzleDatabases.delete(invocations)
      throw error
    })
    drizzleDatabases.set(invocations, database)
  }
  return await database
}
