import { getConsoleAgents } from "./agents.ts"
import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest } from "./request.ts"

import type { ConsoleRequestEvent } from "./request.ts"

interface ConsoleAgentsResult {
  agents: readonly string[]
}

const agentsHandler: (event: ConsoleRequestEvent) => Promise<ConsoleAgentsResult> = async (event) => {
  assertConsoleRequest(event)
  const agents = new Set(getConsoleAgents())
  for (const agentName of await getConsoleInvocations().listAgentNames()) agents.add(agentName)
  return { agents: [...agents].sort() }
}

export default agentsHandler
