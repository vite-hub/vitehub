import { agentDiagnostics } from "../agent-diagnostics.ts"

const maxTablePrefixLength = 25

/**
 * The SQL names of the Postgres journal tables for one `tablePrefix`. It lives apart from the Drizzle tables, so the
 * store does not load `drizzle-orm/pg-core` in apps that use SQLite, libSQL, or D1.
 */
export function postgresAgentInvocationTableNames(tablePrefix = "vitehub_agent_"): { invocations: string, observations: string } {
  const invocations = `${tablePrefix}invocations`
  // Lowercase, because Postgres folds the unquoted names in the store's SQL. At most 25 characters, because the longest
  // derived name, the observation foreign key, adds 38 characters and Postgres keeps 63 bytes of a name.
  if (tablePrefix.length > maxTablePrefixLength || !/^[a-z_][a-z0-9_]*$/.test(invocations)) {
    throw agentDiagnostics.AGENT_R0910({ message: `[vitehub] Postgres Agent Invocation tablePrefix must be lowercase letters, digits, and underscores, start with a letter or underscore, and have at most ${maxTablePrefixLength} characters.` })
  }
  return { invocations, observations: `${invocations}_observations` }
}
