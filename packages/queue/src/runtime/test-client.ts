import { normalizeQueueEnqueueInput } from "../enqueue.ts"

import type { ViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"
import type { LocalQueueClient, QueueEnqueueOptions } from "../types.ts"

/** One job that the app sent while test mode was on. */
export interface QueueTestMessage {
  id: string
  options: Omit<QueueEnqueueOptions, "id">
  payload: unknown
  queue: string
}

/** The sent jobs of the current test. `vite-hub/test` reads the same list. */
export function queueTestMessages(test: ViteHubTestMode): QueueTestMessage[] {
  return test.backend("queue", () => [] as QueueTestMessage[])
}

/** Records the job and does not run it, so a test asserts what the app sent. */
export function recordQueueTestMessage(test: ViteHubTestMode, queue: string, payload: unknown, options?: QueueEnqueueOptions): { messageId: string, status: "queued" } {
  const input = normalizeQueueEnqueueInput(payload, options)
  queueTestMessages(test).push({ id: input.id, options: input.options, payload: structuredClone(input.payload), queue })
  return { messageId: input.id, status: "queued" }
}

/** A Queue client that records every job in the test's list. */
export function createTestQueueClient(test: ViteHubTestMode, queue: string): LocalQueueClient {
  return {
    native: undefined,
    provider: "local",
    queue,
    async send(payload, options) {
      return [undefined, recordQueueTestMessage(test, queue, payload, options)]
    },
    async sendBatch(items, options) {
      return [undefined, items.map((item) => {
        const delaySeconds = item.delaySeconds ?? options?.delaySeconds
        return recordQueueTestMessage(test, queue, item.body, {
          ...(delaySeconds === undefined ? {} : { delaySeconds }),
          ...(item.idempotencyKey === undefined ? {} : { idempotencyKey: item.idempotencyKey }),
        })
      })]
    },
  }
}
