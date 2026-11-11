import { resolveDefaultAgentInvocations } from "./app.ts"
import { defaultAgentInvocationsDatabase } from "./default-core.ts"

import type { AgentInvocations } from "../invocations.ts"
import type { AgentInvocationsDatabase } from "./journal-database.ts"

export type { AgentInvocationsDatabase } from "./journal-database.ts"

const drizzleDatabases = new WeakMap<AgentInvocations, Promise<AgentInvocationsDatabase | undefined>>()

async function openDrizzleDatabase(invocations: AgentInvocations): Promise<AgentInvocationsDatabase | undefined> {
  const database = defaultAgentInvocationsDatabase(invocations)
  if (!database) return undefined
  // Load Drizzle on first use, so a server that never queries the journal does not need drizzle-orm.
  const { createD1InvocationsDatabase, createLibsqlInvocationsDatabase } = await import("./journal-database.ts")
  return database.driver === "libsql"
    ? createLibsqlInvocationsDatabase(await database.open())
    : createD1InvocationsDatabase(database.open)
}

/**
 * Opens Drizzle over the default journal on first use, for queries and `db.batch()` writes. It needs `drizzle-orm`.
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
