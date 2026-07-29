import type { StreamEvent } from "../messages.ts"

export const agentOutputEventObserverContextKey = "agent.output.eventObserver"
export const progressSummaryOutputContextKey = "agent.output.progressSummary"

export type AgentOutputEventObserver = (event: StreamEvent) => void
