import { afterEach, describe, expect, it, vi } from "vitest"

import { createQueue, createQueueClient, defineQueue, getQueue, getVercelQueueTopicName, runQueue } from "../src/index.ts"
import { createCloudflareQueueBatchHandler } from "../src/providers/cloudflare.ts"
import { createMemoryQueueClient } from "../src/providers/memory.ts"
import { resetQueueRuntimeState, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/runtime/state.ts"
import type { MemoryQueueClient, VercelQueueSDK } from "../src/types.ts"

afterEach(() => {
  vi.doUnmock("@vercel/queue")
  resetQueueRuntimeState()
})

function mockVercelQueueSDK(send: VercelQueueSDK["send"]) {
  vi.resetModules()
  vi.doMock("@vercel/queue", () => ({
    handleCallback: vi.fn(),
    QueueClient: undefined,
    send,
  }))
}

describe("queue definition helpers", () => {
  it("keeps createQueue as a compatibility wrapper", async () => {
    const definition = createQueue<{ email: string }>({
      cache: false,
      handler: async job => ({ email: job.payload.email }),
    })

    expect(definition.options).toEqual({ cache: false })
    await expect(definition.handler({
      attempts: 1,
      id: "job-1",
      payload: { email: "ava@example.com" },
      signal: new AbortController().signal,
    })).resolves.toEqual({ email: "ava@example.com" })
  })

  it("validates unknown createQueue options", () => {
    expect(() => createQueue({
      handler: async () => undefined,
      unknown: true,
    } as never)).toThrow("Unknown queue definition option `unknown`.")
  })
})

describe("memory provider", () => {
  it("stores, peeks, and drains messages", async () => {
    const queue = createMemoryQueueClient()

    const result = await queue.send({ id: "job-1", payload: { ok: true } })

    expect(queue.provider).toBe("memory")
    if (queue.provider !== "memory") throw new Error("expected memory")
    expect(result.messageId).toBe("job-1")
    expect(queue.size()).toBe(1)
    expect(queue.peek(1)[0]).toMatchObject({
      messageId: "job-1",
      payload: { ok: true },
    })

    const drained: unknown[] = []
    await queue.drain(payload => drained.push(payload))

    expect(drained).toEqual([{ ok: true }])
    expect(queue.size()).toBe(0)
  })

  it("supports destructured batch sending", async () => {
    const queue = createMemoryQueueClient()

    expect(queue.provider).toBe("memory")
    if (queue.provider !== "memory") throw new Error("expected memory")

    const { sendBatch } = queue
    await sendBatch([{ id: "job-1", payload: { ok: true } }])

    expect(queue.peek(1)[0]).toMatchObject({
      messageId: "job-1",
      payload: { ok: true },
    })
  })

  it("treats payload-only objects as bare payloads", async () => {
    const queue = createMemoryQueueClient()

    await queue.send<{ other: boolean, payload: string }>({ other: true, payload: "kept" })

    expect(queue.provider).toBe("memory")
    if (queue.provider !== "memory") throw new Error("expected memory")
    expect(queue.peek(1)[0]!.payload).toEqual({ other: true, payload: "kept" })
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

  it("does not retain auto-dispatched memory jobs", async () => {
    setQueueRuntimeConfig({ provider: { provider: "memory" } })
    setQueueRuntimeRegistry({
      "welcome-email": async () => ({ default: defineQueue(async () => undefined) }),
    })

    await runQueue("welcome-email", { id: "welcome-ava", payload: { email: "ava@example.com" } })
    await new Promise(resolve => setTimeout(resolve, 0))

    const queue = await getQueue("welcome-email") as unknown as MemoryQueueClient
    expect(queue.provider).toBe("memory")
    if (queue.provider !== "memory") throw new Error("expected memory")
    expect(queue.size()).toBe(0)
    await expect(queue.drain(() => undefined)).resolves.toBe(0)
  })

  it("does not consume older memory jobs with duplicate IDs when auto-dispatching", async () => {
    const handled = vi.fn()
    setQueueRuntimeConfig({ provider: { provider: "memory" } })
    setQueueRuntimeRegistry({
      "welcome-email": async () => ({
        default: defineQueue<{ email: string }>(async (job) => {
          handled(job.payload.email)
        }) as never,
      }),
    })

    const queue = await getQueue("welcome-email") as unknown as MemoryQueueClient
    expect(queue.provider).toBe("memory")
    if (queue.provider !== "memory") throw new Error("expected memory")

    await queue.send({ id: "welcome-ava", payload: { email: "old@example.com" } })
    await runQueue("welcome-email", { id: "welcome-ava", payload: { email: "new@example.com" } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(handled).toHaveBeenCalledWith("new@example.com")
    expect(queue.peek(1)[0]).toMatchObject({
      messageId: "welcome-ava",
      payload: { email: "old@example.com" },
    })
  })

  it("respects provider-level cache disablement", async () => {
    setQueueRuntimeConfig({ provider: { cache: false, provider: "memory" } })
    setQueueRuntimeRegistry({
      "welcome-email": async () => ({ default: defineQueue(async () => undefined) }),
    })

    const first = await getQueue("welcome-email")
    const second = await getQueue("welcome-email")

    expect(first).not.toBe(second)
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
    const batchResult = await queue.sendBatch([{ body: { hello: "batch" }, contentType: "json" }])
    expect(sendBatch).toHaveBeenCalledWith([{ body: { hello: "batch" }, contentType: "json" }])
    expect(batchResult).toEqual([{ status: "queued" }])
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

  it("resolves Cloudflare bindings from the scoped runtime event without reusing cached clients", async () => {
    const sendA = vi.fn(async () => ({}))
    const sendB = vi.fn(async () => ({}))
    const sendBatch = vi.fn(async () => ({}))
    setQueueRuntimeConfig({ provider: { provider: "cloudflare" } })
    setQueueRuntimeRegistry({
      "welcome-email": async () => ({ default: defineQueue(async () => undefined) }),
    })

    const eventFor = (send: typeof sendA) => ({
      context: { cloudflare: { env: { QUEUE_77656C636F6D652D656D61696C: { send, sendBatch } } } },
    })
    const queueA = await runWithQueueRuntimeEvent(eventFor(sendA), () => getQueue("welcome-email"))
    const queueB = await runWithQueueRuntimeEvent(eventFor(sendB), () => getQueue("welcome-email"))

    await queueA.send({ id: "a", payload: { id: "a" } })
    await queueB.send({ id: "b", payload: { id: "b" } })

    expect(sendA).toHaveBeenCalledWith({ id: "a" }, { contentType: undefined, delaySeconds: undefined })
    expect(sendB).toHaveBeenCalledWith({ id: "b" }, { contentType: undefined, delaySeconds: undefined })
  })

  it("resolves Cloudflare bindings from scoped queue runtime context", async () => {
    const send = vi.fn(async () => ({}))
    const sendBatch = vi.fn(async () => ({}))
    setQueueRuntimeConfig({ provider: { provider: "cloudflare" } })
    setQueueRuntimeRegistry({
      child: async () => ({ default: defineQueue(async () => undefined) }),
    })

    await runWithQueueRuntimeEvent({
      env: {
        QUEUE_6368696C64: { send, sendBatch },
      },
    }, async () => {
      await runQueue("child", { ok: true })
    })

    expect(send).toHaveBeenCalledWith({ ok: true }, { contentType: undefined, delaySeconds: undefined })
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

  it("falls back to one worker when concurrency is NaN", async () => {
    const ack = vi.fn()
    const retry = vi.fn()
    const onMessage = vi.fn()
    const handler = createCloudflareQueueBatchHandler({
      concurrency: Number.NaN,
      onMessage,
    })

    await handler({
      ackAll: vi.fn(),
      messages: [
        { ack, attempts: 1, body: "first", id: "m1", retry, timestamp: new Date() },
        { ack, attempts: 1, body: "second", id: "m2", retry, timestamp: new Date() },
      ],
      queue: "jobs",
      retryAll: vi.fn(),
    })

    expect(onMessage).toHaveBeenCalledTimes(2)
    expect(ack).toHaveBeenCalledTimes(2)
    expect(retry).not.toHaveBeenCalled()
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
      payload: { email: "ava@example.com" },
      region: "iad1",
    })

    expect(result).toEqual({ status: "queued", messageId: "msg_vercel" })
    expect(send).toHaveBeenCalledWith("welcome-email", { email: "ava@example.com" }, {
      delaySeconds: undefined,
      idempotencyKey: expect.any(String),
      region: "iad1",
      retentionSeconds: undefined,
    })
  })

  it("normalizes Vercel null message IDs to undefined", async () => {
    const queue = await createQueueClient({
      client: {
        handleCallback: vi.fn(),
        send: vi.fn(async () => ({ messageId: null })),
      },
      provider: "vercel",
      topic: "welcome-email",
    })

    await expect(queue.send({ ok: true })).resolves.toEqual({
      status: "queued",
      messageId: undefined,
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
    mockVercelQueueSDK(send)
    setQueueRuntimeConfig({
      provider: {
        provider: "vercel",
      },
    })
    setQueueRuntimeRegistry({
      "welcome-email": async () => ({ default: defineQueue(async () => undefined) }),
    })

    const queue = await getQueue("welcome-email")
    await queue.send({ ok: true })

    expect(queue.provider).toBe("vercel")
    expect(send).toHaveBeenCalledWith("welcome-email", { ok: true }, expect.objectContaining({
      idempotencyKey: expect.any(String),
    }))
  })

  it("uses Vercel-safe topics for nested queue definitions", async () => {
    const send = vi.fn(async () => ({ messageId: "msg_nested" }))
    mockVercelQueueSDK(send)
    setQueueRuntimeConfig({
      provider: {
        provider: "vercel",
      },
    })
    setQueueRuntimeRegistry({
      "email/welcome": async () => ({ default: defineQueue(async () => undefined) }),
    })

    const queue = await getQueue("email/welcome")
    await queue.send({ id: "welcome-ava", payload: { ok: true } })

    expect(queue.provider).toBe("vercel")
    if (queue.provider !== "vercel") throw new Error("expected vercel")
    expect(queue.topic).toBe(getVercelQueueTopicName("email/welcome"))
    expect(send).toHaveBeenCalledWith(getVercelQueueTopicName("email/welcome"), { ok: true }, expect.any(Object))
  })
})
