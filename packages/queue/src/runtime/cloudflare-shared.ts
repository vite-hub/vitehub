import {
  createCloudflareRuntimeEvent,
  setActiveCloudflareEnv,
  type CloudflareWorkerEnv,
  type CloudflareWorkerExecutionContext,
} from "@vitehub/internal/runtime/cloudflare-env"

import type { CloudflareQueueMessageBatch } from "../types.ts"

export { createCloudflareRuntimeEvent, setActiveCloudflareEnv }
export type { CloudflareWorkerEnv, CloudflareWorkerExecutionContext }

export function createQueueJob(message: CloudflareQueueMessageBatch["messages"][number], batch: CloudflareQueueMessageBatch): {
  attempts: number
  id: string
  metadata: { batch: CloudflareQueueMessageBatch, message: CloudflareQueueMessageBatch["messages"][number] }
  payload: unknown
} {
  return {
    attempts: typeof message.attempts === "number" ? message.attempts : 1,
    id: message.id,
    metadata: { batch, message },
    payload: message.body,
  }
}
