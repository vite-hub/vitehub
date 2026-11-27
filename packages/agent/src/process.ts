/**
 * Long-running Node hosts for Agents: process hosts that a preset attaches to an Agent Definition, the
 * self-hosted process host, adaptive process capacity, and process-owned Invocation storage.
 */
export { agentProcessHostIntake, getAgentProcessHostContribution, registerAgentProcessHostIntake, withAgentProcessHost } from "./process-host.ts"
export type { AgentProcessHostContext, AgentProcessHostContribution, AgentProcessHostInstance, AgentProcessHostIntake } from "./process-host.ts"
export * from "./runtime/process.ts"
