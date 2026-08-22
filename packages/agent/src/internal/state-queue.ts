import type { QueueEntry, StateAdapter } from "chat"

import { isRuntimeFunction, isRuntimeNumber, isRuntimeObject } from "./runtime-value.ts"

export interface AtomicAgentStateQueueAdapter extends StateAdapter {
  queuePeek(threadId: string): Promise<QueueEntry | null>
  queueReplaceHead(threadId: string, expected: QueueEntry | null, replacement: QueueEntry[], maxSize: number): Promise<boolean>
}

export function parseAgentStateQueueEntry(serialized: string): QueueEntry {
  const value: unknown = JSON.parse(serialized)
  if (
    !isRuntimeObject(value) ||
    !("enqueuedAt" in value) ||
    !isRuntimeNumber(value.enqueuedAt) ||
    !("expiresAt" in value) ||
    !isRuntimeNumber(value.expiresAt) ||
    !("message" in value) ||
    !isRuntimeObject(value.message)
  ) {
    throw new TypeError("[vitehub] Agent State queue contains an invalid entry.")
  }
  // SAFETY: The persisted queue entry's timestamps and serialized message object were validated above.
  return value as QueueEntry
}

export function requireAtomicAgentStateQueue(state: StateAdapter): AtomicAgentStateQueueAdapter {
  // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
  const candidate = state as Partial<AtomicAgentStateQueueAdapter>
  if (!isRuntimeFunction(candidate.queuePeek) || !isRuntimeFunction(candidate.queueReplaceHead)) {
    throw new Error("[vitehub] Durable steered Channel delivery requires State with atomic queue replacement support.")
  }
  // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
  return candidate as AtomicAgentStateQueueAdapter
}
