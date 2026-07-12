import { runScheduledAgent } from "../index.ts"

import type { AgentInput, AgentRuntimeContext, ResolvedAgentRuntimeContext } from "../types.ts"

interface ScheduledAgentTargetRunContext {
  attemptId?: string
  id: string
  input?: unknown
  runId?: string
  scheduleId?: string
  scheduledAt: Date
  target?: string
}

interface ScheduledAgentTargetDefinition {
  handler: (context: ScheduledAgentTargetRunContext) => Promise<unknown>
  options: {
    allowRuntimeSchedules: true
  }
}

export function defineScheduledAgentTarget(
  agent: AgentInput<AgentRuntimeContext>,
  runtimeContext: Partial<ResolvedAgentRuntimeContext> = {},
): ScheduledAgentTargetDefinition {
  return {
    handler: async context => await runScheduledAgent(agent, context, runtimeContext),
    options: { allowRuntimeSchedules: true },
  }
}
