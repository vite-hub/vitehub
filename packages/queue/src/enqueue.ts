import type { NormalizedQueueEnqueueInput, QueueEnqueueOptions } from "./types.ts"

let fallbackCounter = 0

export function createQueueMessageId(prefix = "queue"): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) {
    return `${prefix}_${uuid}`
  }

  fallbackCounter = (fallbackCounter + 1) >>> 0
  return `${prefix}_${Date.now().toString(36)}_${fallbackCounter.toString(36)}`
}

/** Payload properties never select enqueue options. The message ID is always generated. */
export function normalizeQueueEnqueueInput<TPayload>(payload: TPayload, options: QueueEnqueueOptions = {}): NormalizedQueueEnqueueInput<TPayload> {
  return { id: createQueueMessageId(), options: { ...options }, payload }
}
