import { getConsoleInvocations } from "./invocations.ts"
import { consoleHttpError } from "./http-error.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

/** The capabilities and the triggering people of the recorded invocations, for the `invocations.capabilities` operation. */
export async function listConsoleInvocationCapabilities(input: { agent?: string }): Promise<{
  capabilities: readonly string[]
  triggeredBy: readonly string[]
}> {
  const agentName = input.agent?.trim() || undefined
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
