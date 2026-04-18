import type { QueueEnqueueInput, QueueEnqueueOptions } from "./types.ts"

const envelopeDiscriminatorKeys = new Set([
  "contentType",
  "delaySeconds",
  "id",
  "idempotencyKey",
  "retentionSeconds",
])

let fallbackCounter = 0

export interface NormalizedQueueEnqueueInput<TPayload = unknown> {
  id: string
  options: QueueEnqueueOptions
  payload: TPayload
}

export function createQueueMessageId(prefix = "queue"): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `${prefix}_${uuid}`
  fallbackCounter = (fallbackCounter + 1) >>> 0
  return `${prefix}_${Date.now().toString(36)}_${fallbackCounter.toString(36)}`
}

function isQueueEnqueueInput<TPayload>(
  input: unknown,
): input is QueueEnqueueOptions & { id?: string, payload: TPayload } {
  return Boolean(input)
    && typeof input === "object"
    && !Array.isArray(input)
    && input !== null
    && "payload" in input
    && Object.keys(input).some(key => envelopeDiscriminatorKeys.has(key))
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
