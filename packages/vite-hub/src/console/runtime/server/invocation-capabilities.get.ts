import { getConsoleInvocations } from "./invocations.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts"

import type { ConsoleRequestEvent } from "./request.ts"

export default async function consoleInvocationCapabilitiesHandler(event: ConsoleRequestEvent): Promise<{
  capabilities: readonly string[]
}> {
  assertConsoleRequest(event)
  const agentName = consoleRequestURL(event).searchParams.get("agent")?.trim() || undefined
  if (agentName && agentName.length > 512) {
    throw Object.assign(new Error("Invalid Agent name"), {
      statusCode: 400,
      statusMessage: "Invalid Agent name",
    })
  }
  return { capabilities: await getConsoleInvocations().listCapabilityIds(agentName) }
}
