import { consoleAgentInvokerProfiles, getConsoleAgentDefinition, getConsoleAgents } from "./agents.ts"
import { getConsoleInvocations } from "./invocations.ts"

interface ConsoleAgentsResult {
  /** Agents registered in this application. */
  agents: readonly string[]
  /** Agent names recorded in invocation history. This includes Agents that are no longer registered. */
  invocationAgents: readonly string[]
  invocation?: Record<string, { profiles: ReturnType<typeof consoleAgentInvokerProfiles> }>
}

/** The Agents of the `agents.list` operation. */
export async function listConsoleAgents(): Promise<ConsoleAgentsResult> {
  const registeredNames = [...new Set(getConsoleAgents())].sort()
  const invocationAgents = [...new Set(await getConsoleInvocations().listAgentNames())].sort()
  const invocation = Object.fromEntries(registeredNames.flatMap((name) => {
    const agent = getConsoleAgentDefinition(name)
    return agent ? [[name, { profiles: consoleAgentInvokerProfiles(agent) }]] : []
  }))
  const result: ConsoleAgentsResult = { agents: registeredNames, invocationAgents }
  if (Object.keys(invocation).length) result.invocation = invocation
  return result
}
