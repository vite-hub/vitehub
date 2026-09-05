import { getConsoleAgentDefinition, getConsoleAgents } from "./agents.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { createConsoleStatusReader } from "./status.ts"

import type { AgentProviderStatus } from "@vite-hub/agent"
import type { ConsoleRequestEvent } from "./request.ts"

const readStatus = createConsoleStatusReader()

export default async function statusHandler(event: ConsoleRequestEvent): Promise<{ agents: AgentProviderStatus[] }> {
  assertConsoleRequest(event)
  const name = consoleRequestURL(event).searchParams.get("agent")?.trim()
  if (name && name.length > 512) throw Object.assign(new Error("Invalid Agent name."), { statusCode: 400 })
  const names = name ? [name] : getConsoleAgents()
  return { agents: await Promise.all(names.map(async name => {
    const agent = getConsoleAgentDefinition(name, "inspect")
    if (!agent) throw Object.assign(new Error("Agent status is unavailable."), { statusCode: 404 })
    return readStatus(agent, name)
  })) }
}
