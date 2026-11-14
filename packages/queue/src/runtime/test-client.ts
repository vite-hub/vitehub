import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { queueUnsupportedOptionsError } from "../errors.ts"

import type { ViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"
import type { LocalQueueClient, NormalizedQueueEnqueueInput, QueueEnqueueOptions, QueueProvider } from "../types.ts"

/** One job that the app sent while test mode was on. */
export interface QueueTestMessage {
  id: string
  options: QueueEnqueueOptions
  payload: unknown
  queue: string
}

/** The sent jobs of the current test. `vite-hub/test` reads the same list. */
export function queueTestMessages(test: ViteHubTestMode): QueueTestMessage[] {
  return test.backend("queue", () => [] as QueueTestMessage[])
}

/** Records the job and does not run it, so a test asserts what the app sent. */
function recordQueueTestMessage(test: ViteHubTestMode, queue: string, input: NormalizedQueueEnqueueInput): { messageId: string, status: "queued" } {
  const messages = queueTestMessages(test)
  const duplicate = input.options.idempotencyKey === undefined
    ? undefined
    : messages.find(message => message.queue === queue && message.options.idempotencyKey === input.options.idempotencyKey)
  if (duplicate) return { messageId: duplicate.id, status: "queued" }
  messages.push({ id: input.id, options: input.options, payload: structuredClone(input.payload), queue })
  return { messageId: input.id, status: "queued" }
}

/** A Queue client that records every job in the test's list. */
export function createTestQueueClient(test: ViteHubTestMode, queue: string, provider: QueueProvider): LocalQueueClient {
  return {
    native: undefined,
    provider: "local",
    queue,
    async send(payload, options) {
      const input = normalizeQueueEnqueueInput(payload, options)
      const error = queueUnsupportedOptionsError(input.options, provider)
      if (error) return [error, undefined]
      return [undefined, recordQueueTestMessage(test, queue, input)]
    },
    async sendBatch(items: ({ body: unknown } & QueueEnqueueOptions)[], options: QueueEnqueueOptions = {}) {
      const inputs = items.map(({ body, ...itemOptions }) => normalizeQueueEnqueueInput(body, {
        ...options,
        ...Object.fromEntries(Object.entries(itemOptions).filter(([, value]) => value !== undefined)),
      }))
      // Reject the whole batch before recording any jobs.
      for (const input of inputs) {
        const error = queueUnsupportedOptionsError(input.options, provider)
        if (error) return [error, undefined]
      }
      return [undefined, inputs.map(input => recordQueueTestMessage(test, queue, input))]
    },
  }
}
