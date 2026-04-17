import type { QueueEnqueueInput, QueueEnqueueOptions } from "./types.ts"

export interface NormalizedQueueEnqueueInput<TPayload = unknown> {
  id: string
  options: QueueEnqueueOptions
  payload: TPayload
}

export function createQueueMessageId(prefix = "queue"): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`
}

function isQueueEnqueueInput<TPayload>(
  input: QueueEnqueueInput<TPayload>,
): input is QueueEnqueueOptions & { id?: string, payload: TPayload } {
  return typeof input === "object" && input !== null && !Array.isArray(input) && "payload" in input
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
