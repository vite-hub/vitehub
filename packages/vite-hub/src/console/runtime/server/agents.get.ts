import { consoleAgentInvokerProfiles, getConsoleAgentDefinition, getConsoleAgents } from "./agents.ts"
import { getConsoleInvocations } from "./invocations.ts"
import { withConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { assertConsoleRequest } from "./request.ts"

import type { ConsoleRequestEvent } from "./request.ts"

interface ConsoleAgentsResult {
  /** Agents registered in this application. */
  agents: readonly string[]
  /** Agent names recorded in invocation history. This includes Agents that are no longer registered. */
  invocationAgents: readonly string[]
  invocation?: Record<string, { profiles: ReturnType<typeof consoleAgentInvokerProfiles> }>
}

const agentsHandler: (event: ConsoleRequestEvent) => Promise<ConsoleAgentsResult> = async (event) => {
  assertConsoleRequest(event)
  const names = [...new Set(getConsoleAgents())].sort()
  const invocationAgents = [...new Set(await getConsoleInvocations().listAgentNames())].sort()
  const invocation = Object.fromEntries(names.flatMap((name) => {
    const agent = getConsoleAgentDefinition(name)
    return agent ? [[name, { profiles: consoleAgentInvokerProfiles(agent) }]] : []
  }))
  const result: ConsoleAgentsResult = { agents: names, invocationAgents }
  if (Object.keys(invocation).length) result.invocation = invocation
  return result
}

const guardedHandler: ConsoleAccessRoute<typeof agentsHandler> = withConsoleAccess(agentsHandler, { section: "agents" })
export default guardedHandler
