import type { NormalizedQueueEnqueueInput, QueueEnqueueEnvelope, QueueEnqueueInput, QueueEnqueueOptions } from "./types.ts"

const envelopeKeys = new Set([
  "contentType",
  "delaySeconds",
  "id",
  "idempotencyKey",
  "region",
  "retentionSeconds",
])

export function createQueueMessageId(prefix = "queue"): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`
}

function isQueueEnvelope<TPayload = unknown>(input: QueueEnqueueInput<TPayload>): input is QueueEnqueueEnvelope<TPayload> {
  if (typeof input !== "object" || input === null || Array.isArray(input) || !("payload" in input)) {
    return false
  }
  return Object.keys(input).every(key => key === "payload" || envelopeKeys.has(key))
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
