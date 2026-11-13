import { afterAll, beforeEach, expect, it, vi } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import { setQueueRuntimeConfig, setQueueRuntimeEventDefaults, setQueueRuntimeRegistry } from "../src/internal/runtime/state.ts"
import { dynamicQueue } from "../src/runtime/client.ts"

import type { QueueEnqueueOptions, QueueProvider } from "../src/types.ts"

const mode = enableViteHubTestMode()
const handler = vi.fn()
const createClient = vi.fn()

beforeEach(async () => {
  await mode.reset()
  vi.clearAllMocks()
  setQueueRuntimeConfig({ provider: "local" }, createClient)
  setQueueRuntimeRegistry({ welcome: async () => ({ handler }), digest: async () => ({ handler }) })
})

afterAll(async () => {
  await mode.reset()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
  setQueueRuntimeConfig(undefined)
  setQueueRuntimeRegistry(undefined)
})

it("records valid sends and deferred sends without a provider or handler, and reset empties the list", async () => {
  const pending: Promise<unknown>[] = []
  setQueueRuntimeEventDefaults({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) })
  const [sendError, first] = await dynamicQueue.send("welcome", { userId: 1 }, { delaySeconds: 60 })
  expect(sendError).toBeUndefined()
  dynamicQueue.defer("welcome", { userId: 2 })
  await Promise.all(pending)
  const queue = await dynamicQueue.use("digest")
  const [error, sent] = await queue.sendBatch([{ body: { day: 1 }, delaySeconds: undefined }], { delaySeconds: 5 })

  expect(error).toBeUndefined()
  expect(sent).toHaveLength(1)
  expect(mode.peek("queue")).toMatchObject([
    { id: first?.messageId, options: { delaySeconds: 60 }, payload: { userId: 1 }, queue: "welcome" },
    { options: {}, payload: { userId: 2 }, queue: "welcome" },
    { options: { delaySeconds: 5 }, payload: { day: 1 }, queue: "digest" },
  ])
  expect(handler).not.toHaveBeenCalled()
  expect(createClient).not.toHaveBeenCalled()

  await mode.reset()
  expect(mode.peek("queue")).toBeUndefined()
})

it("rejects disabled Queues and unknown Definitions", async () => {
  setQueueRuntimeConfig(false)
  await expect(dynamicQueue.use("welcome")).rejects.toMatchObject({ code: "QUEUE_DISABLED" })
  await expect(dynamicQueue.send("welcome", {})).rejects.toMatchObject({ code: "QUEUE_DISABLED" })
  setQueueRuntimeConfig({ provider: "cloudflare" })
  await expect(dynamicQueue.send("misspelled", {})).rejects.toMatchObject({ code: "QUEUE_DEFINITION_NOT_FOUND" })
  expect(mode.peek("queue")).toBeUndefined()
})

it.each<QueueProvider>(["local", "vercel"])("deduplicates %s sends and batches by Queue and idempotency key until reset", async (provider) => {
  setQueueRuntimeConfig({ provider })
  const queue = await dynamicQueue.use("welcome")
  const [error, first] = await queue.send({ userId: 1 }, { idempotencyKey: "signup" })
  expect(error).toBeUndefined()
  expect(await queue.send({ userId: 2 }, { idempotencyKey: "signup" })).toEqual([undefined, first])
  const [batchError, batch] = await queue.sendBatch([
    { body: { userId: 3 }, idempotencyKey: "signup" },
    { body: { userId: 4 }, idempotencyKey: "digest" },
    { body: { userId: 5 }, idempotencyKey: "digest" },
  ])
  expect(batchError).toBeUndefined()
  expect(batch?.[0]).toEqual(first)
  expect(batch?.[2]).toEqual(batch?.[1])

  const otherQueue = await dynamicQueue.use("digest")
  await otherQueue.send({ userId: 6 }, { idempotencyKey: "signup" })
  await queue.send({ userId: 7 })
  await queue.send({ userId: 7 })
  expect(mode.peek("queue")).toMatchObject([
    { id: first?.messageId, queue: "welcome", payload: { userId: 1 } },
    { queue: "welcome", payload: { userId: 4 } },
    { queue: "digest", payload: { userId: 6 } },
    { queue: "welcome", payload: { userId: 7 } },
    { queue: "welcome", payload: { userId: 7 } },
  ])

  await mode.reset()
  const [, afterReset] = await queue.send({ userId: 8 }, { idempotencyKey: "signup" })
  expect(afterReset?.messageId).not.toBe(first?.messageId)
  expect(mode.peek("queue")).toMatchObject([{ id: afterReset?.messageId, payload: { userId: 8 } }])
})

it.each<[QueueProvider, QueueEnqueueOptions]>([
  ["cloudflare", { idempotencyKey: "key" }],
  ["cloudflare", { region: "iad1" }],
  ["cloudflare", { retentionSeconds: 60 }],
  ["vercel", { contentType: "json" }],
  ["local", { region: "iad1" }],
])("preserves %s option validation in sends and batches (%j)", async (provider, options) => {
  setQueueRuntimeConfig({ provider })
  const queue = await dynamicQueue.use("welcome")
  expect(await queue.send({}, options)).toMatchObject([{ code: "QUEUE_UNSUPPORTED_OPTION" }, undefined])
  expect(await queue.sendBatch([{ body: {} }], options)).toMatchObject([{ code: "QUEUE_UNSUPPORTED_OPTION" }, undefined])
  expect(mode.peek("queue")).toBeUndefined()
})

it("uses the configured local delivery rules", async () => {
  setQueueRuntimeConfig({ provider: "local", rules: "cloudflare" })
  expect(await dynamicQueue.send("welcome", {}, { idempotencyKey: "key" })).toMatchObject([{ code: "QUEUE_UNSUPPORTED_OPTION" }, undefined])
})

it("reports a deferred validation failure through the host task and dispatch-error hook", async () => {
  const pending: Promise<unknown>[] = []
  const onDispatchError = vi.fn()
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  setQueueRuntimeConfig({ provider: "cloudflare" })
  setQueueRuntimeRegistry({ welcome: async () => ({ handler, options: { onDispatchError } }) })
  setQueueRuntimeEventDefaults({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) })
  try {
    dynamicQueue.defer("welcome", {}, { region: "iad1" })
    await Promise.all(pending)
    expect(onDispatchError).toHaveBeenCalledWith(expect.objectContaining({ code: "QUEUE_UNSUPPORTED_OPTION" }), { name: "welcome" })
    expect(mode.peek("queue")).toBeUndefined()
  }
  finally {
    log.mockRestore()
  }
})
