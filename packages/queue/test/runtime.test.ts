import { createServer } from "node:http"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createCloudflareQueueBatchHandler } from "../src/providers/cloudflare.ts"
import { getCloudflareQueueBindingName } from "../src/integrations/cloudflare.ts"
import { createVercelQueueClient } from "../src/providers/vercel.ts"
import { runQueue } from "../src/runtime/client.ts"
import { createQueueCloudflareWorker } from "../src/runtime/cloudflare-vite.ts"
import { createQueueVercelServer } from "../src/runtime/vercel-vite.ts"
import { deferQueue } from "../src/runtime/client.ts"
import { runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/runtime/state.ts"

const vercelQueueMock = vi.hoisted(() => {
  const state = {
    handleCallback: vi.fn(() => async () => new Response("queued")),
    options: undefined as { region: string } | undefined,
    send: vi.fn(async () => ({ messageId: "message-1" })),
  }

  return state
})

const vercelFunctionsMock = vi.hoisted(() => ({
  waitUntil: vi.fn(),
}))

vi.mock("@vercel/queue", () => ({
  QueueClient: class {
    constructor(options: { region: string }) {
      vercelQueueMock.options = options
    }

    handleCallback = vercelQueueMock.handleCallback
    send = vercelQueueMock.send
  },
}))

vi.mock("@vercel/functions", () => ({
  waitUntil: vercelFunctionsMock.waitUntil,
}))

afterEach(() => {
  setQueueRuntimeConfig(undefined)
  setQueueRuntimeRegistry(undefined)
  vercelQueueMock.handleCallback.mockClear()
  vercelQueueMock.options = undefined
  vercelQueueMock.send.mockClear()
  vercelFunctionsMock.waitUntil.mockClear()
  delete process.env.QUEUE_REGION
  delete process.env.VERCEL_REGION
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

  it("defaults omitted queue config to the Cloudflare provider", async () => {
    const send = vi.fn(async () => {})
    const worker = createQueueCloudflareWorker({
      app: async () => Response.json(await runQueue("welcome", { email: "ava@example.com" })),
      registry: {
        welcome: async () => ({
          default: {
            handler: async () => {},
          },
        }),
      },
    })

    const response = await worker.fetch(new Request("https://example.com/"), {
      [getCloudflareQueueBindingName("welcome")]: {
        send,
        sendBatch: vi.fn(async () => {}),
      },
    }, { waitUntil: vi.fn() })

    expect(await response.json()).toEqual(expect.objectContaining({
      status: "queued",
    }))
    expect(send).toHaveBeenCalledTimes(1)
    expect(vercelQueueMock.send).not.toHaveBeenCalled()
  })

  it("uses nested Cloudflare waitUntil for deferred dispatch", async () => {
    const send = vi.fn(async () => {})
    const waitUntil = vi.fn()
    const sendBatch = vi.fn(async () => {})

    setQueueRuntimeConfig({ provider: "cloudflare" })
    setQueueRuntimeRegistry({
      welcome: async () => ({
        default: {
          handler: async () => {},
        },
      }),
    })

    await runWithQueueRuntimeEvent({
      context: {
        cloudflare: {
          context: { waitUntil },
          env: {
            [getCloudflareQueueBindingName("welcome")]: { send, sendBatch },
          },
        },
      },
    }, async () => {
      deferQueue("welcome", { email: "ava@example.com" })
      await Promise.resolve()
    })

    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0]?.[0]
    expect(send).toHaveBeenCalledTimes(1)
    expect(vercelQueueMock.send).not.toHaveBeenCalled()
  })

  it("binds Cloudflare waitUntil to the original owner", async () => {
    const send = vi.fn(async () => {})
    const sendBatch = vi.fn(async () => {})
    const owner = {
      calls: 0,
      waitUntil(this: { calls: number }, promise: Promise<unknown>) {
        this.calls += 1
        void promise
      },
    }

    setQueueRuntimeConfig({ provider: "cloudflare" })
    setQueueRuntimeRegistry({
      welcome: async () => ({
        default: {
          handler: async () => {},
        },
      }),
    })

    await runWithQueueRuntimeEvent({
      req: {
        runtime: {
          cloudflare: {
            context: owner,
            env: {
              [getCloudflareQueueBindingName("welcome")]: { send, sendBatch },
            },
          },
        },
      },
    }, async () => {
      deferQueue("welcome", { email: "ava@example.com" })
      await Promise.resolve()
    })

    expect(owner.calls).toBe(1)
  })

  it("uses Nitro request waitUntil for deferred Cloudflare queue dispatch", async () => {
    const send = vi.fn(async () => {})
    const sendBatch = vi.fn(async () => {})
    const waitUntil = vi.fn()

    setQueueRuntimeConfig({ provider: "cloudflare" })
    setQueueRuntimeRegistry({
      welcome: async () => ({
        default: {
          handler: async () => {},
        },
      }),
    })

    await runWithQueueRuntimeEvent({
      req: {
        runtime: {
          cloudflare: {
            env: {
              [getCloudflareQueueBindingName("welcome")]: { send, sendBatch },
            },
          },
        },
        waitUntil,
      },
    }, async () => {
      deferQueue("welcome", { email: "ava@example.com" })
      await Promise.resolve()
    })

    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0]?.[0]
    expect(send).toHaveBeenCalledTimes(1)
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

  it("uses provider region as the default send region", async () => {
    const send = vi.fn(async () => ({ messageId: "message-1" }))
    const client = await createVercelQueueClient({
      client: {
        handleCallback: vi.fn(() => async () => new Response("queued")),
        send,
      },
      provider: "vercel",
      region: "fra1",
      topic: "topic--77656c636f6d65",
    })

    await client.send({ email: "ava@example.com" })
    await client.send({ payload: { email: "ava@example.com" }, region: "iad1" })

    expect(send).toHaveBeenNthCalledWith(1, "topic--77656c636f6d65", { email: "ava@example.com" }, expect.objectContaining({
      idempotencyKey: expect.any(String),
      region: "fra1",
    }))
    expect(send).toHaveBeenNthCalledWith(2, "topic--77656c636f6d65", { email: "ava@example.com" }, expect.objectContaining({
      idempotencyKey: expect.any(String),
      region: "iad1",
    }))
  })

  it("infers the sdk region from the Vercel runtime env", async () => {
    process.env.VERCEL_REGION = "iad1"

    const client = await createVercelQueueClient({
      provider: "vercel",
      topic: "topic--77656c636f6d65",
    })

    await client.send({ email: "ava@example.com" })

    expect(vercelQueueMock.options).toEqual({ region: "iad1" })
    expect(vercelQueueMock.send).toHaveBeenCalledWith("topic--77656c636f6d65", { email: "ava@example.com" }, expect.objectContaining({
      idempotencyKey: expect.any(String),
    }))
  })

  it("uses Vercel waitUntil for deferred dispatch", async () => {
    process.env.VERCEL_REGION = "iad1"

    const server = createServer(createQueueVercelServer({
      app: async () => {
        deferQueue("welcome-email", { email: "ava@example.com" })
        return new Response("ok")
      },
      queue: { provider: "vercel" },
      registry: {
        "welcome-email": async () => ({
          default: {
            handler: async () => {},
          },
        }),
      },
    }))

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const address = server.address()
    if (!address || typeof address === "string") {
      throw new TypeError("Expected server address.")
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/`)
    expect(await response.text()).toBe("ok")
    expect(vercelFunctionsMock.waitUntil).toHaveBeenCalledTimes(1)
    expect(vercelQueueMock.send).toHaveBeenCalledTimes(1)

    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
})
