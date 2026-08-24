import { getConsoleAgents } from "./agents.ts"
import { assertConsoleRequest } from "./request.ts"

import type { ConsoleRequestEvent } from "./request.ts"

interface ConsoleAgentsResult {
  agents: readonly string[]
}

const agentsHandler: (event: ConsoleRequestEvent) => ConsoleAgentsResult = (event) => {
  assertConsoleRequest(event)
  return { agents: getConsoleAgents() }
}

export default agentsHandler
