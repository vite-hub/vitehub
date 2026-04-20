import type { CloudflareQueueMessageBatch } from "../types.ts"

export type CloudflareWorkerEnv = Record<string, unknown>

export type CloudflareWorkerExecutionContext = {
  waitUntil?: (promise: Promise<unknown>) => void
}

export function setActiveCloudflareEnv(env: CloudflareWorkerEnv): void {
  ;(globalThis as { __env__?: CloudflareWorkerEnv }).__env__ = env
}

export function createCloudflareRuntimeEvent(env: CloudflareWorkerEnv, context: CloudflareWorkerExecutionContext | undefined): {
  context: { cloudflare: { context: CloudflareWorkerExecutionContext | undefined, env: CloudflareWorkerEnv }, waitUntil?: (promise: Promise<unknown>) => void }
  env: CloudflareWorkerEnv
  waitUntil?: (promise: Promise<unknown>) => void
} {
  const waitUntil = typeof context?.waitUntil === "function" ? context.waitUntil.bind(context) : undefined
  return {
    context: { cloudflare: { env, context }, waitUntil },
    env,
    waitUntil,
  }
}

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
