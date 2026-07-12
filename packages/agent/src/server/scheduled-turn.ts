import { runScheduledAgent } from "../index.ts"

import type { AgentInput, AgentRuntimeContext } from "../types.ts"
import type { ScheduleTargetDefinition } from "@vite-hub/schedule"

export function defineScheduledAgentTarget(agent: AgentInput<AgentRuntimeContext>): ScheduleTargetDefinition {
  return {
    handler: async context => await runScheduledAgent(agent, context),
    options: { allowRuntimeSchedules: true },
  }
}
