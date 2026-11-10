import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"
import { getConsoleAgentDefinition, getConsoleAgents } from "./agents.ts"
import { withConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { assertConsoleRequest, consoleRequestURL, consoleRoute } from "./request.ts"
import { consoleHttpError } from "./http-error.ts"
import { createAgentStatusReader } from "@vite-hub/agent/server"
import { observabilityStatus } from "@vite-hub/agent/server/internal"

import type { AgentProviderStatus } from "@vite-hub/agent"
import type { ObservabilityStatus } from "@vite-hub/agent/observability"
import type { ConsoleRequestEvent, ConsoleRoute } from "./request.ts"

const readStatus = createAgentStatusReader()

/** `observability` is `null` when `vitehub({ observability })` is not set. */
async function statusHandler(event: ConsoleRequestEvent): Promise<{ agents: AgentProviderStatus[], observability: ObservabilityStatus | null }> {
  assertConsoleRequest(event)
  const name = consoleRequestURL(event).searchParams.get("agent")?.trim()
  if (name && name.length > 512) {
    throw consoleHttpError(400, viteHubErrorDiagnostics.VITE_HUB_R0113({ message: "Invalid Agent name." }))
  }
  const names = name ? [name] : getConsoleAgents()
  const agents = await Promise.all(names.map(async name => {
    const agent = getConsoleAgentDefinition(name, "inspect")
    if (!agent) throw consoleHttpError(404, viteHubErrorDiagnostics.VITE_HUB_R0114({ message: "Agent status is unavailable." }))
    return readStatus(agent, name)
  }))
  return { agents, observability: observabilityStatus() }
}

/** The status of the Agents, for the `status.get` operation. */
export const readConsoleStatus: ConsoleAccessRoute<typeof statusHandler> = withConsoleAccess(statusHandler, { section: "agents" })

/** `GET <base>/api/_vitehub/console/status` */
const consoleStatusRoute: ConsoleRoute = consoleRoute(readConsoleStatus)
export default consoleStatusRoute
