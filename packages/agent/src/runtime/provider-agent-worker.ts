import { agentDiagnostics } from "../agent-diagnostics.ts"

import type { createProviderAgentAdapter as createNodeProviderAgentAdapter, inspectAgentProvider as inspectNodeAgentProvider } from "../provider-agent.ts"

// Worker builds resolve "#vitehub/agent/provider-agent" to this module through the "workerd" and "worker"
// package import conditions. The Node provider path and @t3tools/provider-runtime stay out of the Worker bundle.
function providerAgentUnavailable(): never {
  throw agentDiagnostics.AGENT_R0928()
}

export const createProviderAgentAdapter: typeof createNodeProviderAgentAdapter = providerAgentUnavailable
export const inspectAgentProvider: typeof inspectNodeAgentProvider = providerAgentUnavailable
