import type { NormalizedQueueEnqueueInput, QueueEnqueueEnvelope, QueueEnqueueInput, QueueEnqueueOptions } from "./types.ts"

const envelopeKeys = new Set([
  "contentType",
  "delaySeconds",
  "id",
  "idempotencyKey",
  "region",
  "retentionSeconds",
])

let fallbackCounter = 0

export function createQueueMessageId(prefix = "queue"): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) {
    return `${prefix}_${uuid}`
  }

  fallbackCounter = (fallbackCounter + 1) >>> 0
  return `${prefix}_${Date.now().toString(36)}_${fallbackCounter.toString(36)}`
}

function isQueueEnvelope<TPayload = unknown>(input: QueueEnqueueInput<TPayload>): input is QueueEnqueueEnvelope<TPayload> {
  if (typeof input !== "object" || input === null || Array.isArray(input) || !("payload" in input)) {
    return false
  }

  for (const key of Object.keys(input)) {
    if (envelopeKeys.has(key)) {
      return true
    }
  }

  return false
}

export function normalizeQueueEnqueueInput<TPayload = unknown>(input: QueueEnqueueInput<TPayload>): NormalizedQueueEnqueueInput<TPayload> {
  if (!isQueueEnvelope(input)) {
    return {
      id: createQueueMessageId(),
      options: {},
      payload: input,
    }
  }

  const { contentType, delaySeconds, id, idempotencyKey, payload, region, retentionSeconds } = input
  const options: QueueEnqueueOptions = {
    ...(contentType !== undefined ? { contentType } : {}),
    ...(delaySeconds !== undefined ? { delaySeconds } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(retentionSeconds !== undefined ? { retentionSeconds } : {}),
  }
  return {
    id: typeof id === "string" && id.length > 0 ? id : createQueueMessageId(),
    options,
    payload,
  }
}
