import { defineScheduleTarget } from "@vite-hub/schedule"

import { runScheduledAgent } from "../index.ts"

import type { AgentInput, AgentRuntimeContext } from "../types.ts"
import type { ScheduleTargetDefinition } from "@vite-hub/schedule"

export function defineScheduledAgentTarget(agent: AgentInput<AgentRuntimeContext>): ScheduleTargetDefinition {
  return defineScheduleTarget({
    handler: async context => await runScheduledAgent(agent, context),
  })
}
