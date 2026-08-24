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
  let cursor: string | undefined
  // ponytail: Add a store-level distinct-name query if large journals make this compatibility scan measurable.
  do {
    const page = await getConsoleInvocations().list({ cursor, limit: 100 })
    for (const invocation of page.invocations) {
      if (invocation.agentName) agents.add(invocation.agentName)
    }
    cursor = page.cursor
  } while (cursor)
  return { agents: [...agents].sort() }
}

export default agentsHandler
