import { AsyncLocalStorage } from "node:async_hooks"
import { createServer } from "node:http"

import { clearActiveCloudflareEnv, getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { ViteHubError } from "@vite-hub/runtime"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createCloudflareQueueBatchHandler, createCloudflareQueueClient } from "../src/providers/cloudflare.ts"
import { getCloudflareQueueBindingName } from "../src/integrations/cloudflare.ts"
import { createVercelQueueClient } from "../src/providers/vercel.ts"
import { handleHostedVercelQueueCallback } from "../src/runtime/hosted.ts"
import { runQueue } from "../src/runtime/client.ts"
import { createQueueCloudflareWorker } from "../src/internal/runtime/cloudflare-vite.ts"
import { createCloudflareQueueRuntimeClient } from "../src/internal/runtime/cloudflare-client.ts"
import { createQueueClient } from "../src/runtime/create-client.ts"
import { createQueueVercelServer } from "../src/internal/runtime/vercel-vite.ts"
import { createVercelQueueRuntimeClient } from "../src/internal/runtime/vercel-client.ts"
import { deferQueue } from "../src/runtime/client.ts"
import { enterQueueRuntimeEvent, getQueueRuntimeClientFactory, getQueueRuntimeEvent, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/internal/runtime/state.ts"

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
  clearActiveCloudflareEnv()
})

describe("cloudflare queue runtime", () => {
  it("clears the selected client factory when Queue support is disabled", () => {
    setQueueRuntimeConfig({ provider: "vercel" }, createVercelQueueRuntimeClient)
    expect(getQueueRuntimeClientFactory()).toBe(createVercelQueueRuntimeClient)

    setQueueRuntimeConfig(false)
    expect(getQueueRuntimeClientFactory()).toBeUndefined()
  })

  it("selects an explicit Queue client without generated runtime state", async () => {
    const cloudflareSend = vi.fn(async () => {})
    const cloudflare = await createQueueClient({ binding: { send: cloudflareSend, sendBatch: vi.fn(async () => {}) }, provider: "cloudflare" })
    await cloudflare.send({ payload: "cloudflare" })
    expect(cloudflareSend).toHaveBeenCalledWith("cloudflare", {})

    const vercelSend = vi.fn(async () => ({ messageId: "message-1" }))
    const vercel = await createQueueClient({
      client: { handleCallback: vi.fn(), send: vercelSend },
      provider: "vercel",
      topic: "topic",
    })
    await vercel.send({ payload: "vercel" })
    expect(vercelSend).toHaveBeenCalledWith("topic", "vercel", expect.any(Object))
  })

  it("rejects region for single and batch sends while forwarding supported options", async () => {
    const send = vi.fn(async () => {})
    const sendBatch = vi.fn(async () => {})
    const client = createCloudflareQueueClient({
      binding: { send, sendBatch },
      provider: "cloudflare",
    })

    const unsupportedRegion = {
      code: "CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS",
      details: { provider: "cloudflare", unsupported: ["region"] },
    }
    await expect(client.send({ payload: { id: 1 }, region: "weur" })).rejects.toMatchObject(unsupportedRegion)
    await expect(client.sendBatch([{ body: { id: 2 } }], { region: "weur" })).rejects.toMatchObject(unsupportedRegion)
    expect(send).not.toHaveBeenCalled()
    expect(sendBatch).not.toHaveBeenCalled()

    await client.send({ contentType: "json", delaySeconds: 1, payload: { id: 3 } })
    await client.sendBatch([{ body: { id: 4 }, contentType: "json" }], { delaySeconds: 2 })
    expect(send).toHaveBeenCalledWith({ id: 3 }, { contentType: "json", delaySeconds: 1 })
    expect(sendBatch).toHaveBeenCalledWith([{ body: { id: 4 }, contentType: "json", delaySeconds: 2 }])
  })

  it("sets the Cloudflare environment when enterWith is unavailable", () => {
    const env = { QUEUE_WELCOME: {} }
    vi.spyOn(AsyncLocalStorage.prototype, "enterWith").mockImplementation(() => {
      throw new Error("enterWith is unavailable")
    })
    const event = { env }
    expect(() => enterQueueRuntimeEvent(event)).not.toThrow()
    expect(getActiveCloudflareEnv()).toBe(env)
    expect(getQueueRuntimeEvent()).toBeUndefined()
  })

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

  it("honors explicit Cloudflare delivery directives", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    const first = { ack: vi.fn(), retry: vi.fn() }
    const second = { ack: vi.fn(), retry: vi.fn() }
    const onError = vi.fn((_error: unknown, message: { body: string }) => message.body === "override" ? "retry" as const : "ack" as const)
    const batchHandler = createCloudflareQueueBatchHandler<string>({
      onError,
      onMessage: async () => {
        throw new ViteHubError("INVALID_PAYLOAD", "Invalid payload.")
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
    expect(report.mock.calls[0]?.[1]).toMatchObject({ queue: "image-expiry", retryable: true })
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
    const custom = new ViteHubError("WELCOME_EMAIL_REJECTED", "Welcome email was rejected.")
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

  it("isolates overlapping Cloudflare fetch environments", async () => {
    let arrivals = 0
    let release!: () => void
    const bothStarted = new Promise<void>(resolve => {
      release = resolve
    })
    const worker = createQueueCloudflareWorker({
      app: async () => {
        const before = getActiveCloudflareEnv()?.REQUEST_ID
        arrivals += 1
        if (arrivals === 2) release()
        await bothStarted
        return Response.json({ after: getActiveCloudflareEnv()?.REQUEST_ID, before })
      },
    })

    const [first, second] = await Promise.all([
      worker.fetch(new Request("https://example.com/first"), { REQUEST_ID: "first" }, { waitUntil: vi.fn() }),
      worker.fetch(new Request("https://example.com/second"), { REQUEST_ID: "second" }, { waitUntil: vi.fn() }),
    ])

    await expect(first.json()).resolves.toEqual({ after: "first", before: "first" })
    await expect(second.json()).resolves.toEqual({ after: "second", before: "second" })
  })

  it("isolates overlapping Cloudflare consumer environments", async () => {
    let arrivals = 0
    let release!: () => void
    const bothStarted = new Promise<void>(resolve => {
      release = resolve
    })
    const observed = new Map<string, unknown[]>()
    const worker = createQueueCloudflareWorker({
      registry: {
        welcome: async () => ({
          default: {
            handler: async ({ payload }) => {
              const requestId = String(payload && typeof payload === "object" && "requestId" in payload ? payload.requestId : "")
              const values = [getActiveCloudflareEnv()?.REQUEST_ID]
              observed.set(requestId, values)
              arrivals += 1
              if (arrivals === 2) release()
              await bothStarted
              values.push(getActiveCloudflareEnv()?.REQUEST_ID)
            },
          },
        }),
      },
    })
    const createBatch = (requestId: string) => ({
      ackAll: vi.fn(),
      messages: [{ ack: vi.fn(), attempts: 1, body: { requestId }, id: requestId, retry: vi.fn() }],
      queue: "welcome",
      retryAll: vi.fn(),
    })

    await Promise.all([
      worker.queue(createBatch("first"), { REQUEST_ID: "first" }, { waitUntil: vi.fn() }),
      worker.queue(createBatch("second"), { REQUEST_ID: "second" }, { waitUntil: vi.fn() }),
    ])

    expect(observed.get("first")).toEqual(["first", "first"])
    expect(observed.get("second")).toEqual(["second", "second"])
  })

  it("dispatches prefixed physical names in manually constructed Cloudflare workers", async () => {
    const handler = vi.fn(async () => {})
    const worker = createQueueCloudflareWorker({
      queue: { namePrefix: "preview-", provider: "cloudflare" },
      registry: {
        abcdefghijklmnop: async () => ({
          default: { handler },
        }),
        welcome: async () => ({
          default: { handler },
        }),
      },
    })

    await worker.queue({
      ackAll: vi.fn(),
      messages: [{ ack: vi.fn(), attempts: 1, body: { id: 1 }, id: "1", retry: vi.fn() }],
      queue: "preview-queue--77656c636f6d65",
      retryAll: vi.fn(),
    }, {}, { waitUntil: vi.fn() })

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ payload: { id: 1 } }))
    await worker.queue({
      ackAll: vi.fn(),
      messages: [{ ack: vi.fn(), attempts: 1, body: { id: 2 }, id: "2", retry: vi.fn() }],
      queue: "preview-queue--6162636465666768696a6b6c6d6e6f70",
      retryAll: vi.fn(),
    }, {}, { waitUntil: vi.fn() })
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ payload: { id: 2 } }))

    await worker.queue({
      ackAll: vi.fn(),
      messages: [{ ack: vi.fn(), attempts: 1, body: { id: 3 }, id: "3", retry: vi.fn() }],
      queue: "preview-welcome",
      retryAll: vi.fn(),
    }, {}, { waitUntil: vi.fn() })
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ payload: { id: 3 } }))

    await expect(worker.queue({
      ackAll: vi.fn(),
      messages: [],
      queue: "queue--77656c636f6d65",
      retryAll: vi.fn(),
    }, {}, { waitUntil: vi.fn() })).rejects.toThrow("is not mapped to a Queue Definition")
    await expect(worker.queue({
      ackAll: vi.fn(),
      messages: [],
      queue: "preview-welcome-0123456789abcdef0123456789abcdef",
      retryAll: vi.fn(),
    }, {}, { waitUntil: vi.fn() })).rejects.toThrow("is not mapped to a Queue Definition")
  })

  it("derives bounded physical names from manual worker registries", async () => {
    const handler = vi.fn(async () => {})
    const worker = createQueueCloudflareWorker({
      queue: { namePrefix: `${"deployment".repeat(8)}-`, provider: "cloudflare" },
      registry: {
        "images/nested/optimization-aaaaaaaa": async () => ({ default: { handler } }),
      },
    })

    await worker.queue({
      ackAll: vi.fn(),
      messages: [{ ack: vi.fn(), attempts: 1, body: { id: 1 }, id: "1", retry: vi.fn() }],
      queue: "deploymentdeploymentdeployment-f537f0129ff2b8673b34a44f70a00fad",
      retryAll: vi.fn(),
    }, {}, { waitUntil: vi.fn() })

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ payload: { id: 1 } }))
  })

  it("rejects unknown physical and logical Cloudflare queue mappings", async () => {
    const worker = createQueueCloudflareWorker({
      definitions: { "preview-queue--77656c636f6d65": "missing" },
      registry: {},
    })
    const createBatch = (queue: string) => ({
      ackAll: vi.fn(),
      messages: [{ ack: vi.fn(), attempts: 1, body: {}, id: "1", retry: vi.fn() }],
      queue,
      retryAll: vi.fn(),
    })

    await expect(worker.queue(createBatch("unknown"), {}, { waitUntil: vi.fn() })).rejects.toThrow("is not mapped to a Queue Definition")
    await expect(worker.queue(createBatch("preview-queue--77656c636f6d65"), {}, { waitUntil: vi.fn() })).rejects.toThrow('maps to unknown Queue Definition "missing"')
  })

  it("uses nested Cloudflare waitUntil for deferred dispatch", async () => {
    const send = vi.fn(async () => {})
    const waitUntil = vi.fn()
    const sendBatch = vi.fn(async () => {})

    setQueueRuntimeConfig({ provider: "cloudflare" }, createCloudflareQueueRuntimeClient)
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

    setQueueRuntimeConfig({ provider: "cloudflare" }, createCloudflareQueueRuntimeClient)
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

    setQueueRuntimeConfig({ provider: "cloudflare" }, createCloudflareQueueRuntimeClient)
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
  it("requires a selected client factory for default manual servers", () => {
    expect(() => createQueueVercelServer({} as never)).toThrow("requires its generated client factory")
    expect(() => createQueueVercelServer({ queue: false })).not.toThrow()
  })

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

  it.each([{}, { messageId: null }])("accepts a Vercel send response without a message id", async (response) => {
    const client = await createVercelQueueClient({
      client: {
        handleCallback: vi.fn(() => async () => new Response("queued")),
        send: vi.fn().mockResolvedValue(response),
      },
      provider: "vercel",
      topic: "topic--77656c636f6d65",
    })

    await expect(client.send({ email: "ava@example.com" })).resolves.toEqual({
      messageId: undefined,
      status: "queued",
    })
  })

  it.each([
    [null, null],
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

  it("preserves Vercel behavior when the retry callback returns undefined", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    const retry = vi.fn(() => undefined)
    const definition = {
      handler: async () => {
        throw new ViteHubError("INVALID_PAYLOAD", "Invalid payload.", { cause: new Error("private provider detail") })
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
    setQueueRuntimeConfig({ provider: "vercel", region: "iad1" }, createVercelQueueRuntimeClient)
    setQueueRuntimeRegistry({ welcome: async () => ({ default: definition }) })

    const result = await handleHostedVercelQueueCallback({ request: new Request("https://example.com") }, "welcome", definition)

    expect(result).toBeUndefined()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      attempts: 3,
      id: "message-3",
      provider: "vercel",
      queue: "welcome",
      retryable: true,
    })
    expect(JSON.stringify(report.mock.calls[0]?.[1])).not.toContain("private provider detail")
  })

  it("preserves an explicit Vercel retry directive", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const retry = vi.fn(() => ({ afterSeconds: 30 } as const))
    const definition = {
      handler: async () => {
        throw new ViteHubError("INVALID_PAYLOAD", "Invalid payload.")
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
    setQueueRuntimeConfig({ provider: "vercel", region: "iad1" }, createVercelQueueRuntimeClient)
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

  it("infers the sdk region from Nitro node request headers", async () => {
    await runWithQueueRuntimeEvent({ node: { req: { headers: { "x-vercel-id": "fra1::iad1::request" } } } }, async () => {
      const client = await createVercelQueueClient({
        provider: "vercel",
        topic: "topic--77656c636f6d65",
      })

      await client.send({ email: "ava@example.com" })
    })

    expect(vercelQueueMock.options).toEqual({ region: "fra1" })
  })

  it("does not cache regions inferred from Vercel requests", async () => {
    setQueueRuntimeConfig({ provider: "vercel" }, createVercelQueueRuntimeClient)
    setQueueRuntimeRegistry({
      welcome: async () => ({ handler: async () => {} }),
    })

    await runWithQueueRuntimeEvent({ node: { req: { headers: { "x-vercel-id": "fra1::request" } } } }, () => runQueue("welcome", { email: "ava@example.com" }))
    expect(vercelQueueMock.options).toEqual({ region: "fra1" })
    await runWithQueueRuntimeEvent({ node: { req: { headers: { "x-vercel-id": "iad1::request" } } } }, () => runQueue("welcome", { email: "ava@example.com" }))
    expect(vercelQueueMock.options).toEqual({ region: "iad1" })
  })

  it("uses Vercel waitUntil for deferred dispatch", async () => {
    process.env.VERCEL_REGION = "iad1"

    const server = createServer(createQueueVercelServer({
      app: async () => {
        deferQueue("welcome-email", { email: "ava@example.com" })
        return new Response("ok")
      },
      createClient: createVercelQueueRuntimeClient,
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
    await vercelFunctionsMock.waitUntil.mock.calls[0]?.[0]
    expect(vercelQueueMock.send).toHaveBeenCalledTimes(1)

    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
})
