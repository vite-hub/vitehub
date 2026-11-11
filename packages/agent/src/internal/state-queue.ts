import type { QueueEntry, StateAdapter } from "chat"

import { agentDiagnostics } from "../agent-diagnostics.ts"

export interface AtomicAgentStateQueueAdapter extends StateAdapter {
  queuePeek(threadId: string): Promise<QueueEntry | null>
  queueReplaceHead(threadId: string, expected: QueueEntry | null, replacement: QueueEntry[], maxSize: number): Promise<boolean>
}

export function parseAgentStateQueueEntry(serialized: string): QueueEntry {
  const value: unknown = JSON.parse(serialized)
  if (
    typeof value !== "object" || value === null ||
    !("enqueuedAt" in value) ||
    typeof value.enqueuedAt !== "number" ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "number" ||
    !("message" in value) ||
    typeof value.message !== "object" || value.message === null
  ) {
    throw agentDiagnostics.AGENT_R0582({ message: "[vitehub] Agent State queue contains an invalid entry." })
  }
  // SAFETY: The persisted queue entry's timestamps and serialized message object were validated above.
  return value as QueueEntry
}

export function requireAtomicAgentStateQueue(state: StateAdapter): AtomicAgentStateQueueAdapter {
  // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
  const candidate = state as Partial<AtomicAgentStateQueueAdapter>
  if (typeof candidate.queuePeek !== "function" || typeof candidate.queueReplaceHead !== "function") {
    throw agentDiagnostics.AGENT_R0583({ message: "[vitehub] Durable steered Channel delivery requires State with atomic queue replacement support." })
  }
  // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
  return candidate as AtomicAgentStateQueueAdapter
}
