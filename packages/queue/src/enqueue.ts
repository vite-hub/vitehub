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
  // Check ownership on the input, while reading enumerable getters only once from the clone.
  const hasOwnId = Object.hasOwn(options, "id")
  const providerOptions = { ...options }
  const id = hasOwnId
    ? Object.hasOwn(providerOptions, "id") ? providerOptions.id : options.id
    : undefined
  delete providerOptions.id
  return {
    id: typeof id === "string" && id.length > 0 ? id : createQueueMessageId(),
    options: providerOptions,
    payload,
  }
}
