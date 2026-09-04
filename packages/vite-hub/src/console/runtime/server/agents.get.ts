import { consoleAgentInvokerProfiles, getConsoleAgentDefinition, getConsoleAgents } from "./agents.ts"
import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest } from "./request.ts"

import type { ConsoleRequestEvent } from "./request.ts"

interface ConsoleAgentsResult {
  agents: readonly string[]
  invocation?: Record<string, { profiles: ReturnType<typeof consoleAgentInvokerProfiles> }>
}

const agentsHandler: (event: ConsoleRequestEvent) => Promise<ConsoleAgentsResult> = async (event) => {
  assertConsoleRequest(event)
  const agents = new Set(getConsoleAgents())
  for (const agentName of await getConsoleInvocations().listAgentNames()) agents.add(agentName)
  const names = [...agents].sort()
  const invocation = Object.fromEntries(names.flatMap((name) => {
    const agent = getConsoleAgentDefinition(name)
    return agent ? [[name, { profiles: consoleAgentInvokerProfiles(agent) }]] : []
  }))
  return {
    agents: names,
    ...(Object.keys(invocation).length ? { invocation } : {}),
  }
}

export default agentsHandler
