import { afterEach, describe, expect, it, vi } from "vitest"

import { setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/internal/runtime/state.ts"
import { createVercelQueueClient } from "../src/providers/vercel.ts"
import { dynamicQueue } from "../src/runtime/client.ts"

import type { QueueClient } from "../src/types.ts"

const registry = { welcome: async () => ({ handler: async () => {} }) }
const config = { driver: "vercel", region: "iad1" } as const

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function createClient() {
  return createVercelQueueClient({
    client: { handleCallback: () => async () => new Response(), send: async () => ({ messageId: "message-1" }) },
    driver: "vercel",
    topic: "welcome",
  })
}

afterEach(() => {
  setQueueRuntimeConfig(undefined)
  setQueueRuntimeRegistry(undefined)
})

describe("Queue client cache lifecycle", () => {
  it("shares a pending creation and reuses its client", async () => {
    const pending = deferred<QueueClient>()
    const started = deferred<void>()
    const factory = vi.fn(() => {
      started.resolve()
      return pending.promise
    })
    setQueueRuntimeConfig(config, factory)
    setQueueRuntimeRegistry(registry)

    const first = dynamicQueue.use("welcome")
    await started.promise
    const second = dynamicQueue.use("welcome")
    const client = await createClient()
    pending.resolve(client)

    expect(await first).toBe(client)
    expect(await second).toBe(client)
    expect(await dynamicQueue.use("welcome")).toBe(client)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it.each(["throw", "reject"] as const)("retries a failed creation after a factory %s", async (failure) => {
    const cause = new Error("provider unavailable")
    const client = await createClient()
    const factory = vi.fn<() => Promise<QueueClient>>(() => Promise.resolve(client)).mockImplementationOnce(() => {
      if (failure === "throw") throw cause
      return Promise.reject(cause)
    })
    setQueueRuntimeConfig(config, factory)
    setQueueRuntimeRegistry(registry)

    await expect(dynamicQueue.use("welcome")).rejects.toMatchObject({ cause })
    expect(await dynamicQueue.use("welcome")).toBe(client)
    expect(await dynamicQueue.use("welcome")).toBe(client)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["config", "pending"],
    ["config", "resolved"],
    ["registry", "pending"],
    ["registry", "resolved"],
  ] as const)("keeps a %s replacement with a %s client when the old creation fails", async (reset, replacementState) => {
    const old = deferred<QueueClient>()
    const oldStarted = deferred<void>()
    const replacement = deferred<QueueClient>()
    const replacementStarted = deferred<void>()
    const client = await createClient()
    const factory = vi.fn<() => Promise<QueueClient>>(() => Promise.resolve(client))
      .mockImplementationOnce(() => {
        oldStarted.resolve()
        return old.promise
      })
      .mockImplementationOnce(() => {
        replacementStarted.resolve()
        return replacement.promise
      })
    setQueueRuntimeConfig(config, factory)
    setQueueRuntimeRegistry(registry)

    const first = dynamicQueue.use("welcome")
    const failed = expect(first).rejects.toMatchObject({ cause: new Error("old creation failed") })
    await oldStarted.promise
    if (reset === "config") setQueueRuntimeConfig(config, factory)
    else setQueueRuntimeRegistry(registry)
    const second = dynamicQueue.use("welcome")
    await replacementStarted.promise
    if (replacementState === "resolved") {
      replacement.resolve(client)
      await second
    }

    old.reject(new Error("old creation failed"))
    await failed
    const third = dynamicQueue.use("welcome")
    replacement.resolve(client)

    expect(await second).toBe(client)
    expect(await third).toBe(client)
    expect(await dynamicQueue.use("welcome")).toBe(client)
    expect(factory).toHaveBeenCalledTimes(2)
  })
})
