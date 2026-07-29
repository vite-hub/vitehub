import type { StreamEvent } from "../messages.ts"

export const agentOutputEventObserverContextKey = "agent.output.eventObserver"

export type AgentOutputEventObserver = (event: StreamEvent) => void
