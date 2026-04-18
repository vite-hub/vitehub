import { afterEach, describe, expect, it, vi } from "vitest"

import { createQueueClient, defineQueue, getQueue, runQueue } from "../src/index.ts"
import { createCloudflareQueueBatchHandler } from "../src/providers/cloudflare.ts"
import { createMemoryQueueClient } from "../src/providers/memory.ts"
import { resetQueueRuntimeState, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/runtime/state.ts"
import type { VercelQueueSDK } from "../src/types.ts"

afterEach(() => {
  resetQueueRuntimeState()
})

describe("memory provider", () => {
  it("stores, peeks, and drains messages", async () => {
    const queue = createMemoryQueueClient()

    await queue.send({ id: "job-1", payload: { ok: true } })

    expect(queue.provider).toBe("memory")
    if (queue.provider !== "memory") throw new Error("expected memory")
    expect(queue.size()).toBe(1)
    expect(queue.peek(1)[0]!.payload).toEqual({ ok: true })

    const drained: unknown[] = []
    await queue.drain(payload => drained.push(payload))

    expect(drained).toEqual([{ ok: true }])
    expect(queue.size()).toBe(0)
  })

  it("runs discovered handlers after enqueue", async () => {
    const handled = vi.fn()
    setQueueRuntimeConfig({ provider: { provider: "memory" } })
    setQueueRuntimeRegistry({
      "welcome-email": async () => ({
        default: defineQueue<{ email: string }>(async (job) => {
          handled(job.payload.email)
        }) as never,
      }),
    })

    await runQueue("welcome-email", { email: "ava@example.com" })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(handled).toHaveBeenCalledWith("ava@example.com")
  })
})

describe("Cloudflare provider", () => {
  it("maps send and batch calls to the binding", async () => {
    const send = vi.fn(async () => ({}))
    const sendBatch = vi.fn(async () => ({}))
    const queue = await createQueueClient({
      binding: { send, sendBatch } as never,
      provider: "cloudflare",
    })

    await queue.send({
      contentType: "json",
      delaySeconds: 3,
      id: "cloudflare-single",
      payload: { hello: "world" },
    })

    expect(send).toHaveBeenCalledWith({ hello: "world" }, {
      contentType: "json",
      delaySeconds: 3,
    })

    if (queue.provider !== "cloudflare") throw new Error("expected cloudflare")
    await queue.sendBatch([{ body: { hello: "batch" }, contentType: "json" }])
    expect(sendBatch).toHaveBeenCalledWith([{ body: { hello: "batch" }, contentType: "json" }])
  })

  it("rejects unsupported enqueue options", async () => {
    const queue = await createQueueClient({
      binding: { send: vi.fn(async () => ({})), sendBatch: vi.fn(async () => ({})) } as never,
      provider: "cloudflare",
    })

    await expect(queue.send({
      idempotencyKey: "dup",
      payload: { ok: true },
    })).rejects.toMatchObject({
      code: "CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS",
      httpStatus: 400,
      provider: "cloudflare",
    })
  })

  it("acks successes and retries failures in batch handlers", async () => {
    const ack = vi.fn()
    const retry = vi.fn()
    const handler = createCloudflareQueueBatchHandler({
      onMessage: async (message) => {
        if (message.body === "retry") throw new Error("retry")
      },
    })

    await handler({
      ackAll: vi.fn(),
      messages: [
        { ack, attempts: 1, body: "ok", id: "m1", retry, timestamp: new Date() },
        { ack, attempts: 1, body: "retry", id: "m2", retry, timestamp: new Date() },
      ],
      metadata: {},
      queue: "jobs",
      retryAll: vi.fn(),
    } as never)

    expect(ack).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledTimes(1)
  })
})

describe("Vercel provider", () => {
  it("maps send calls to the Vercel SDK", async () => {
    const send = vi.fn(async () => ({ messageId: "msg_vercel" }))
    const handleCallback = vi.fn(() => async () => new Response(null, { status: 204 }))
    const client = {
      handleCallback,
      send,
    } satisfies VercelQueueSDK
    const queue = await createQueueClient({
      client,
      provider: "vercel",
      topic: "welcome-email",
    })

    const result = await queue.send({
      delaySeconds: 10,
      id: "welcome-ava",
      payload: { email: "ava@example.com" },
      retentionSeconds: 3600,
    })

    expect(result).toEqual({ status: "queued", messageId: "msg_vercel" })
    expect(send).toHaveBeenCalledWith("welcome-email", { email: "ava@example.com" }, {
      delaySeconds: 10,
      idempotencyKey: "welcome-ava",
      region: undefined,
      retentionSeconds: 3600,
    })
  })

  it("rejects unsupported enqueue options", async () => {
    const queue = await createQueueClient({
      client: {
        handleCallback: vi.fn(),
        send: vi.fn(),
      },
      provider: "vercel",
      topic: "welcome-email",
    })

    await expect(queue.send({
      contentType: "json",
      payload: { ok: true },
    })).rejects.toMatchObject({
      code: "VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS",
      httpStatus: 400,
      provider: "vercel",
    })
  })

  it("injects topic from queue name through getQueue", async () => {
    const send = vi.fn(async () => ({ messageId: "msg_vercel" }))
    setQueueRuntimeConfig({
      provider: {
        client: { handleCallback: vi.fn(), send },
        provider: "vercel",
      },
    })
    setQueueRuntimeRegistry({
      "welcome-email": async () => ({ default: defineQueue(async () => undefined) }),
    })

    const queue = await getQueue("welcome-email")
    await queue.send({ payload: { ok: true } })

    expect(queue.provider).toBe("vercel")
    expect(send).toHaveBeenCalledWith("welcome-email", { ok: true }, expect.objectContaining({
      idempotencyKey: expect.any(String),
    }))
  })
})
