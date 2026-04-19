import type { QueueEnqueueInput, QueueEnqueueOptions } from "./types.ts"

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

const envelopeKeys = new Set<keyof QueueEnqueueOptions | "id">([
  "contentType",
  "delaySeconds",
  "id",
  "idempotencyKey",
  "region",
  "retentionSeconds",
])

function isQueueEnvelope<TPayload>(
  input: unknown,
): input is QueueEnqueueOptions & { id?: string, payload: TPayload } {
  if (typeof input !== "object" || input === null || Array.isArray(input) || !("payload" in input)) return false
  for (const key of Object.keys(input)) {
    if (envelopeKeys.has(key as keyof QueueEnqueueOptions | "id")) return true
  }
  return false
}

export function normalizeQueueEnqueueInput<TPayload = unknown>(
  input: QueueEnqueueInput<TPayload>,
): NormalizedQueueEnqueueInput<TPayload> {
  if (!isQueueEnvelope<TPayload>(input)) {
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
