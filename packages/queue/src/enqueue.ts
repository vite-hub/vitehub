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

/** Payload properties never select enqueue options. */
export function normalizeQueueEnqueueInput<TPayload>(payload: TPayload, options: QueueEnqueueOptions = {}): NormalizedQueueEnqueueInput<TPayload> {
  const { id, ...providerOptions } = options
  return {
    id: typeof id === "string" && id.length > 0 ? id : createQueueMessageId(),
    options: providerOptions,
    payload,
  }
}
