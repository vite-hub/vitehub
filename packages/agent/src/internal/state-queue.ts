import type { QueueEntry, StateAdapter } from "chat"

export interface AtomicAgentStateQueueAdapter extends StateAdapter {
  queuePeek(threadId: string): Promise<QueueEntry | null>
  queueReplaceHead(threadId: string, expected: QueueEntry | null, replacement: QueueEntry[], maxSize: number): Promise<boolean>
}

export function requireAtomicAgentStateQueue(state: StateAdapter): AtomicAgentStateQueueAdapter {
  const candidate = state as Partial<AtomicAgentStateQueueAdapter>
  if (typeof candidate.queuePeek !== "function" || typeof candidate.queueReplaceHead !== "function") {
    throw new Error("[vitehub] Durable steered Channel delivery requires State with atomic queue replacement support.")
  }
  return candidate as AtomicAgentStateQueueAdapter
}
