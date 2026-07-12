import { runScheduledAgent } from "../index.ts"

import type { AgentInput, AgentRuntimeContext, ResolvedAgentRuntimeContext } from "../types.ts"
import type { ScheduleTargetDefinition } from "@vite-hub/schedule"

export function defineScheduledAgentTarget(
  agent: AgentInput<AgentRuntimeContext>,
  runtimeContext: Partial<ResolvedAgentRuntimeContext> = {},
): ScheduleTargetDefinition {
  return {
    handler: async context => await runScheduledAgent(agent, context, runtimeContext),
    options: { allowRuntimeSchedules: true },
  }
}
