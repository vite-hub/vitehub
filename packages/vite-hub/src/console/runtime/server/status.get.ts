import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"
import { getConsoleAgentDefinition, getConsoleAgents } from "./agents.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { createAgentStatusReader } from "@vite-hub/agent/server"
import { observabilityStatus } from "@vite-hub/agent/server/internal"

import type { AgentProviderStatus } from "@vite-hub/agent"
import type { ObservabilityStatus } from "@vite-hub/agent/observability"
import type { ConsoleRequestEvent } from "./request.ts"

const readStatus = createAgentStatusReader()

/** `observability` is `null` when `vitehub({ observability })` is not set. */
export default async function statusHandler(event: ConsoleRequestEvent): Promise<{ agents: AgentProviderStatus[], observability: ObservabilityStatus | null }> {
  assertConsoleRequest(event)
  const name = consoleRequestURL(event).searchParams.get("agent")?.trim()
  if (name && name.length > 512) throw Object.assign(viteHubErrorDiagnostics.VITE_HUB_R0113({ message: "Invalid Agent name." }), { statusCode: 400 })
  const names = name ? [name] : getConsoleAgents()
  const agents = await Promise.all(names.map(async name => {
    const agent = getConsoleAgentDefinition(name, "inspect")
    if (!agent) throw Object.assign(viteHubErrorDiagnostics.VITE_HUB_R0114({ message: "Agent status is unavailable." }), { statusCode: 404 })
    return readStatus(agent, name)
  }))
  return { agents, observability: observabilityStatus() }
}
