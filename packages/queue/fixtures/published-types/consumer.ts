import type { Result } from "@vite-hub/runtime"

import { dynamicQueue, type QueueErrorCode, type QueueSendResult } from "@vite-hub/queue"
import queueNuxt, { type QueueNuxtModuleOptions } from "@vite-hub/queue/nuxt"

export const queueOptions = { provider: "cloudflare" } satisfies QueueNuxtModuleOptions
export const setupQueue: typeof queueNuxt = queueNuxt

const pending = dynamicQueue.run("welcome", { email: "ada@example.test" }) satisfies Promise<Result<QueueSendResult, QueueErrorCode>>

export async function enqueue(): Promise<void> {
  const [error, sent] = await pending
  if (error) {
    error.code satisfies QueueErrorCode
    error.why satisfies string
    // @ts-expect-error Config codes throw. They are not in the returned union.
    void (error.code === "QUEUE_DISABLED")
    return
  }
  sent.status satisfies "queued"
}
