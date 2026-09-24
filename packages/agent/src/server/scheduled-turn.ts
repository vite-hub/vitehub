import { runAgent } from "../index.ts"

import type { AgentInput, AgentRuntimeContext, ResolvedAgentRuntimeContext } from "../types.ts"

interface ScheduledAgentTargetRunContext {
  attemptId?: string
  id: string
  input?: unknown
  runId?: string
  scheduleId?: string
  scheduledAt: Date
  target?: string
  waitUntil?: (promise: PromiseLike<unknown>) => void
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
    handler: async schedule => await runAgent(agent, {
      ...runtimeContext,
      memo: runtimeContext.memo ?? ((_, create) => create()),
      runtime: runtimeContext.runtime ?? "unknown",
      waitUntil: runtimeContext.waitUntil ?? schedule.waitUntil ?? (() => {}),
    }, {}, { schedule, output: "drained" }),
    options: { allowRuntimeSchedules: true },
  }
}
