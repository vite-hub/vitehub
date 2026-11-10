import { getConsoleInvocations } from "./invocations.ts"
import { withConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { consoleHttpError } from "./http-error.ts"

import type { ConsoleRequestEvent } from "./request.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

async function consoleInvocationCapabilitiesHandler(event: ConsoleRequestEvent): Promise<{
  capabilities: readonly string[]
  triggeredBy: readonly string[]
}> {
  assertConsoleRequest(event)
  const agentName = consoleRequestURL(event).searchParams.get("agent")?.trim() || undefined
  if (agentName && agentName.length > 512) {
    throw consoleHttpError(400, viteHubErrorDiagnostics.VITE_HUB_R0053({ message: "Invalid Agent name" }))
  }
  const invocations = getConsoleInvocations()
  const [capabilities, triggeredBy] = await Promise.all([
    invocations.listCapabilityIds(agentName),
    invocations.listTriggeredBy(agentName),
  ])
  return { capabilities, triggeredBy }
}

const guardedHandler: ConsoleAccessRoute<typeof consoleInvocationCapabilitiesHandler> = withConsoleAccess(consoleInvocationCapabilitiesHandler, { section: "agents" })
export default guardedHandler
