import { createServer } from "node:http"

import { afterEach, describe, expect, it, vi } from "vitest"

import { QueueError } from "../src/errors.ts"
import { createCloudflareQueueBatchHandler, createCloudflareQueueClient } from "../src/providers/cloudflare.ts"
import { getCloudflareQueueBindingName } from "../src/integrations/cloudflare.ts"
import { createVercelQueueClient } from "../src/providers/vercel.ts"
import { handleHostedVercelQueueCallback } from "../src/runtime/hosted.ts"
import { runQueue } from "../src/runtime/client.ts"
import { createQueueCloudflareWorker } from "../src/runtime/cloudflare-vite.ts"
import { createQueueVercelServer } from "../src/runtime/vercel-vite.ts"
import { deferQueue } from "../src/runtime/client.ts"
import { runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/runtime/state.ts"

import type { VercelQueueCallbackOptions } from "../src/types.ts"

const vercelQueueMock = vi.hoisted(() => {
  const state = {
    handleCallback: vi.fn<(handler: unknown, options?: unknown) => () => Promise<unknown>>(() => async () => new Response("queued")),
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
  delete (globalThis as Record<string, unknown>).__vitehubVercelQueue
  vi.restoreAllMocks()
})

describe("cloudflare queue runtime", () => {
  it("points direct Node scripts at generated provider output when no registry is loaded", async () => {
    await expect(runQueue("welcome", { email: "ava@example.com" })).rejects.toThrow(/Queue Runtime Registry is installed by generated Provider Output/)
  })

  it("acks successful messages and retries failed ones", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
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
    expect(report).toHaveBeenCalledTimes(1)
  })

  it("acks permanent failures unless onError returns an explicit directive", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    const first = { ack: vi.fn(), retry: vi.fn() }
    const second = { ack: vi.fn(), retry: vi.fn() }
    const onError = vi.fn((_error: unknown, message: { body: string }) => message.body === "override" ? "retry" as const : undefined)
    const batchHandler = createCloudflareQueueBatchHandler<string>({
      onError,
      onMessage: async () => {
        throw new QueueError<"INVALID_PAYLOAD">({
          code: "INVALID_PAYLOAD",
          message: "Invalid payload.",
          retryable: false,
        })
      },
    })

    await batchHandler({
      ackAll: vi.fn(),
      messages: [
        { ...first, attempts: 2, body: "default", id: "1" },
        { ...second, attempts: 2, body: "override", id: "2" },
      ],
      queue: "queue--696d6167652d657870697279",
      retryAll: vi.fn(),
    })

    expect(first.ack).toHaveBeenCalledTimes(1)
    expect(first.retry).not.toHaveBeenCalled()
    expect(second.ack).not.toHaveBeenCalled()
    expect(second.retry).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenCalledTimes(2)
    expect(report.mock.calls[0]?.[1]).toMatchObject({ queue: "image-expiry", retryable: false })
  })

  it("maps Cloudflare send failures without exposing provider payloads", async () => {
    const cause = new Error("Bearer secret-token failed at https://queue.example/private")
    const binding = {
      send: vi.fn().mockRejectedValue(cause),
      sendBatch: vi.fn().mockRejectedValue(cause),
    }
    const client = createCloudflareQueueClient({ binding, provider: "cloudflare" })

    const sendError = await client.send({ email: "ava@example.com" }).catch(error => error)
    const batchError = await client.sendBatch([{ body: { email: "ava@example.com" } }]).catch(error => error)

    expect(sendError).toMatchObject({
      cause,
      code: "QUEUE_PROVIDER_OPERATION_FAILED",
      details: { operation: "send", provider: "cloudflare" },
      message: "[vitehub] cloudflare queue provider failed during send.",
    })
    expect(batchError).toMatchObject({
      cause,
      code: "QUEUE_PROVIDER_OPERATION_FAILED",
      details: { operation: "send-batch", provider: "cloudflare" },
      message: "[vitehub] cloudflare queue provider failed during send-batch.",
    })
    expect(JSON.stringify([sendError, batchError])).not.toMatch(/secret-token|queue\.example|private/)
  })

  it("preserves abort and custom Queue errors from Cloudflare send", async () => {
    const abort = Object.assign(new Error("caller stopped queue send"), { name: "AbortError" })
    const custom = new QueueError<"WELCOME_EMAIL_REJECTED">({
      code: "WELCOME_EMAIL_REJECTED",
      message: "Welcome email was rejected.",
    })
    const send = vi.fn()
      .mockRejectedValueOnce(abort)
      .mockRejectedValueOnce(custom)
    const client = createCloudflareQueueClient({
      binding: { send, sendBatch: vi.fn(async () => {}) },
      provider: "cloudflare",
    })

    await expect(client.send({ email: "ava@example.com" })).rejects.toBe(abort)
    await expect(client.send({ email: "ava@example.com" })).rejects.toBe(custom)
  })

  it("redacts unsafe queue identifiers from definition lookup failures", async () => {
    const name = "https://user:secret-token@queue.example/private"

    const error = await runQueue(name, { email: "ava@example.com" }).catch(error => error)

    expect(error).toMatchObject({
      code: "QUEUE_DEFINITION_NOT_FOUND",
      message: "[vitehub] Queue Definition is not registered. Queue Runtime Registry is installed by generated Provider Output.",
    })
    expect(error.details).toBeUndefined()
    expect(JSON.stringify(error)).not.toMatch(/secret-token|queue\.example|private|https:/)
  })

  it("maps Queue Definition loader failures while retaining the internal cause", async () => {
    const cause = new Error("Bearer secret-token failed at https://queue.example/private")
    const name = "https://user:secret-token@queue.example/private"
    setQueueRuntimeRegistry({ [name]: async () => Promise.reject(cause) })

    const error = await runQueue(name, { email: "ava@example.com" }).catch(error => error)

    expect(error).toMatchObject({
      cause,
      code: "QUEUE_DEFINITION_LOAD_FAILED",
      message: "[vitehub] Queue Definition could not be loaded.",
    })
    expect(error.details).toBeUndefined()
    expect(JSON.stringify(error)).not.toMatch(/secret-token|queue\.example|private|https:/)
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

  it("uses request waitUntil for deferred Cloudflare queue dispatch", async () => {
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

  it("maps Vercel send failures without exposing provider payloads", async () => {
    const cause = new Error("Bearer secret-token failed at https://queue.example/private")
    const client = await createVercelQueueClient({
      client: {
        handleCallback: vi.fn(() => async () => new Response("queued")),
        send: vi.fn().mockRejectedValue(cause),
      },
      provider: "vercel",
      topic: "topic--77656c636f6d65",
    })

    const error = await client.send({ email: "ava@example.com" }).catch(error => error)

    expect(error).toMatchObject({
      cause,
      code: "QUEUE_PROVIDER_OPERATION_FAILED",
      details: { operation: "send", provider: "vercel" },
      message: "[vitehub] vercel queue provider failed during send.",
    })
    expect(JSON.stringify(error)).not.toMatch(/secret-token|queue\.example|private/)
  })

  it.each([
    [null, null],
    [{ providerSecret: "missing-message-id" }, { providerSecret: "missing-message-id" }],
    [{ messageId: "" }, { messageId: "" }],
  ])("maps malformed Vercel send responses without exposing provider payloads", async (response, cause) => {
    const client = await createVercelQueueClient({
      client: {
        handleCallback: vi.fn(() => async () => new Response("queued")),
        send: vi.fn().mockResolvedValue(response),
      },
      provider: "vercel",
      topic: "topic--77656c636f6d65",
    })

    const error = await client.send({ email: "ava@example.com" }).catch(error => error)

    expect(error).toMatchObject({
      cause,
      code: "QUEUE_PROVIDER_RESPONSE_INVALID",
      details: { operation: "send", provider: "vercel" },
      message: "[vitehub] Vercel queue provider returned an invalid send response.",
    })
    expect(JSON.stringify(error)).not.toMatch(/providerSecret|missing-message-id|cause/)
  })

  it("redacts Vercel SDK load failures while retaining the internal cause", async () => {
    const cause = new Error("Cannot load secret-token from https://queue.example/private")
    Object.defineProperty(globalThis, "__vitehubVercelQueue", {
      configurable: true,
      get() {
        throw cause
      },
    })

    const error = await createVercelQueueClient({
      provider: "vercel",
      topic: "topic--77656c636f6d65",
    }).catch(error => error)

    expect(error).toMatchObject({
      cause,
      code: "VERCEL_QUEUE_SDK_LOAD_FAILED",
      details: { operation: "load-sdk", provider: "vercel" },
      message: "[vitehub] Vercel queue SDK could not be loaded.",
    })
    expect(JSON.stringify(error)).not.toMatch(/secret-token|queue\.example|private/)
  })

  it("acknowledges permanent failures when the retry callback returns undefined", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    const retry = vi.fn(() => undefined)
    const definition = {
      handler: async () => {
        throw new QueueError<"INVALID_PAYLOAD">({
          cause: new Error("private provider detail"),
          code: "INVALID_PAYLOAD",
          message: "Invalid payload.",
          retryable: false,
        })
      },
      options: { callbackOptions: { retry } },
    }
    const metadata = { deliveryCount: 3, messageId: "message-3" }

    vercelQueueMock.handleCallback.mockImplementationOnce((handler, options) => async () => {
      try {
        await (handler as (payload: unknown, metadata: unknown) => Promise<unknown>)({}, metadata)
      } catch (error) {
        return (options as VercelQueueCallbackOptions).retry?.(error, metadata)
      }
    })
    setQueueRuntimeConfig({ provider: "vercel", region: "iad1" })
    setQueueRuntimeRegistry({ welcome: async () => ({ default: definition }) })

    const result = await handleHostedVercelQueueCallback({ request: new Request("https://example.com") }, "welcome", definition)

    expect(result).toEqual({ acknowledge: true })
    expect(retry).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      attempts: 3,
      id: "message-3",
      provider: "vercel",
      queue: "welcome",
      retryable: false,
    })
    expect(JSON.stringify(report.mock.calls[0]?.[1])).not.toContain("private provider detail")
  })

  it("preserves an explicit Vercel retry directive for permanent failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const retry = vi.fn(() => ({ afterSeconds: 30 } as const))
    const definition = {
      handler: async () => {
        throw new QueueError<"INVALID_PAYLOAD">({ code: "INVALID_PAYLOAD", message: "Invalid payload.", retryable: false })
      },
      options: { callbackOptions: { retry } },
    }
    const metadata = { deliveryCount: 1, messageId: "message-1" }

    vercelQueueMock.handleCallback.mockImplementationOnce((handler, options) => async () => {
      try {
        await (handler as (payload: unknown, metadata: unknown) => Promise<unknown>)({}, metadata)
      } catch (error) {
        return (options as VercelQueueCallbackOptions).retry?.(error, metadata)
      }
    })
    setQueueRuntimeConfig({ provider: "vercel", region: "iad1" })
    setQueueRuntimeRegistry({ welcome: async () => ({ default: definition }) })

    const result = await handleHostedVercelQueueCallback({ request: new Request("https://example.com") }, "welcome", definition)

    expect(result).toEqual({ afterSeconds: 30 })
    expect(retry).toHaveBeenCalledTimes(1)
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
