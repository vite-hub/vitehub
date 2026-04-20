import { afterEach, describe, expect, it, vi } from "vitest"

import { createCloudflareQueueBatchHandler } from "../src/providers/cloudflare.ts"
import { createVercelQueueClient } from "../src/providers/vercel.ts"
import { createQueueCloudflareWorker } from "../src/runtime/cloudflare-vite.ts"
import { setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/runtime/state.ts"

afterEach(() => {
  setQueueRuntimeConfig(undefined)
  setQueueRuntimeRegistry(undefined)
  vi.restoreAllMocks()
})

describe("cloudflare queue runtime", () => {
  it("acks successful messages and retries failed ones", async () => {
    const ack = vi.fn()
    const retry = vi.fn()
    const batchHandler = createCloudflareQueueBatchHandler({
      onMessage: async (message) => {
        if (message.body === "fail") {
          throw new Error("boom")
        }
      },
    })

    await batchHandler({
      ackAll: vi.fn(),
      messages: [
        { ack, attempts: 1, body: "ok", id: "1", retry },
        { ack, attempts: 1, body: "fail", id: "2", retry },
      ],
      queue: "queue--666f6f",
      retryAll: vi.fn(),
    })

    expect(ack).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it("dispatches fetch and queue handlers with runtime state", async () => {
    const queueHandler = vi.fn()
    const worker = createQueueCloudflareWorker({
      app: () => new Response("ok"),
      queue: { provider: { provider: "cloudflare" } },
      registry: {
        welcome: async () => ({
          default: {
            handler: queueHandler,
          },
        }),
      },
    })

    const response = await worker.fetch(new Request("https://example.com/api/tests/probe"), {}, { waitUntil: vi.fn() })
    expect(await response.text()).toBe("ok")

    await worker.queue({
      ackAll: vi.fn(),
      messages: [{
        ack: vi.fn(),
        attempts: 1,
        body: { email: "ava@example.com" },
        id: "message-1",
        retry: vi.fn(),
      }],
      queue: "welcome",
      retryAll: vi.fn(),
    }, {}, { waitUntil: vi.fn() })

    expect(queueHandler).toHaveBeenCalledTimes(1)
  })
})

describe("vercel provider", () => {
  it("uses the sdk send and callback contract", async () => {
    const send = vi.fn(async () => ({ messageId: "message-1" }))
    const handleCallback = vi.fn(() => async () => new Response("queued"))
    const client = await createVercelQueueClient({
      client: {
        handleCallback,
        send,
      },
      provider: "vercel",
      topic: "topic--77656c636f6d65",
    })

    await client.send({ email: "ava@example.com" })
    expect(send).toHaveBeenCalledWith("topic--77656c636f6d65", { email: "ava@example.com" }, expect.objectContaining({
      idempotencyKey: expect.any(String),
    }))

    const response = await client.callback(async () => {}, {})(new Request("https://example.com"))
    expect(response).toBeInstanceOf(Response)
    expect(handleCallback).toHaveBeenCalledTimes(1)
  })
})
