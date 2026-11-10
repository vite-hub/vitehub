import { agentDiagnostics } from "../agent-diagnostics.ts"

/**
 * The SQL names of the Postgres journal tables for one `tablePrefix`. It lives apart from the Drizzle tables, so the
 * store does not load `drizzle-orm/pg-core` in apps that use SQLite, libSQL, or D1.
 */
export function postgresAgentInvocationTableNames(tablePrefix = "vitehub_agent_"): { invocations: string, observations: string } {
  const invocations = `${tablePrefix}invocations`
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(invocations)) {
    throw agentDiagnostics.AGENT_R0910({ message: "[vitehub] Postgres Agent Invocation tablePrefix must form an SQL identifier." })
  }
  return { invocations, observations: `${invocations}_observations` }
}
