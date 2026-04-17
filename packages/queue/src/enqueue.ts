import type { QueueEnqueueInput, QueueEnqueueOptions } from "./types.ts"

const enqueueOptionKeys = new Set([
  "contentType",
  "delaySeconds",
  "id",
  "idempotencyKey",
  "retentionSeconds",
])

export interface NormalizedQueueEnqueueInput<TPayload = unknown> {
  id: string
  options: QueueEnqueueOptions
  payload: TPayload
}

export function createQueueMessageId(prefix = "queue"): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`
}

function isQueueEnqueueInput<TPayload>(
  input: unknown,
): input is QueueEnqueueOptions & { id?: string, payload: TPayload } {
  return Boolean(input)
    && typeof input === "object"
    && !Array.isArray(input)
    && input !== null
    && "payload" in input
    && Object.keys(input).some(key => enqueueOptionKeys.has(key))
}

export function normalizeQueueEnqueueInput<TPayload = unknown>(
  input: QueueEnqueueInput<TPayload>,
): NormalizedQueueEnqueueInput<TPayload> {
  if (!isQueueEnqueueInput<TPayload>(input)) {
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
