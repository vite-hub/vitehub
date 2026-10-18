import type { RuntimeCapabilities } from "@vite-hub/runtime"

const hostCapabilitiesKey = Symbol.for("vitehub.agent.host-capabilities")

type HostCapabilitiesScope = typeof globalThis & { [hostCapabilitiesKey]?: RuntimeCapabilities }

// SAFETY: The slot is a well-known global symbol, so separately bundled route and Schedule modules share it.
const scope = globalThis as HostCapabilitiesScope

/** The runtime capabilities that the generated host routes give Agents. */
export function agentHostCapabilities(): RuntimeCapabilities | undefined {
  return scope[hostCapabilitiesKey]
}

/** Generated host route modules register their capability record, so a standalone `runAgent()` gets it too. */
export function setAgentHostCapabilities(capabilities: RuntimeCapabilities | undefined): void {
  if (capabilities) scope[hostCapabilitiesKey] = capabilities
  else delete scope[hostCapabilitiesKey]
}
