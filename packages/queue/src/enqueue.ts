import type { NormalizedQueueEnqueueInput, QueueEnqueueInput, QueueEnqueueOptions } from "./types.ts"

let queueMessageCounter = 0

export function createQueueMessageId(prefix = "queue"): string {
  const random = globalThis.crypto?.randomUUID?.()
  if (typeof random === "string" && random.length > 0) return `${prefix}_${random}`

  queueMessageCounter += 1
  return `${prefix}_${Date.now()}_${queueMessageCounter}`
}

function isQueueEnqueueInput<TPayload>(
  input: QueueEnqueueInput<TPayload>,
): input is QueueEnqueueOptions & { id?: string, payload: TPayload } {
  return Boolean(input)
    && typeof input === "object"
    && !Array.isArray(input)
    && input !== null
    && "payload" in input
}

export function normalizeQueueEnqueueInput<TPayload = unknown>(
  input: QueueEnqueueInput<TPayload>,
): NormalizedQueueEnqueueInput<TPayload> {
  if (!isQueueEnqueueInput(input)) {
    return {
      id: createQueueMessageId(),
      options: {},
      payload: input as TPayload,
    }
  }

  const { id, payload, ...options } = input
  return {
    id: typeof id === "string" && id.length > 0 ? id : createQueueMessageId(),
    options,
    payload,
  }
}
