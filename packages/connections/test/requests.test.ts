import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { apiKey } from "../src/api-key.ts"
import { defineConnection } from "../src/definition.ts"
import { createRequestScheduler } from "../src/requests.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createConnectionTransport } from "../src/transport.ts"
import { createStore, testProvider } from "./helpers.ts"

import type { RequestScheduler } from "../src/requests.ts"
import type { ConnectionRequestPolicy } from "../src/types.ts"

const ITEMS = "https://api.example.com/items"
const TOKEN = { accessToken: "key-1", tokenType: "bearer" }

type Reply = Response | Error | "hang"

/** A fake provider that answers from a queue and records when each request starts. */
function fakeFetch(replies: Reply[] = []) {
  const starts: Array<{ at: number, method: string }> = []
  const request = async (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    starts.push({ at: Date.now(), method: init?.method ?? "GET" })
    const reply = replies.shift() ?? new Response("ok")
    if (reply === "hang") {
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    }
    if (reply instanceof Error) throw reply
    return reply
  }
  return { request, starts }
}

function transport(request: typeof fetch, requests?: ConnectionRequestPolicy, options: { mcp?: string, name?: string, scheduler?: RequestScheduler } = {}) {
  const definition = defineConnection({ provider: apiKey({ origins: ["https://api.example.com"], ...(options.mcp ? { mcp: options.mcp } : {}), ...(requests ? { requests } : {}) }) })
  return createConnectionTransport(options.name ?? "items", definition, request, options.scheduler ?? createRequestScheduler())
}

function status(code: number, headers?: Record<string, string>) {
  return new Response(`status ${code}`, { headers, status: code })
}

describe("Connection request policy", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("sends once without a policy", async () => {
    const provider = fakeFetch([status(503)])
    const response = await transport(provider.request).send(ITEMS, TOKEN, { method: "GET" })
    expect(response.status).toBe(503)
    expect(await response.text()).toBe("status 503")
    expect(provider.starts).toEqual([{ at: 0, method: "GET" }])
  })

  it.each([
    [{ intervalMs: 100 }, [0, 100, 200]],
    [{ limit: 5, perMs: 1000 }, [0, 200, 400]],
  ] as const)("spaces request starts evenly (%o)", async (rate, expected) => {
    const provider = fakeFetch()
    const items = transport(provider.request, { rate })
    const sent = Promise.all([1, 2, 3].map(() => items.send(ITEMS, TOKEN, {})))
    await vi.runAllTimersAsync()
    await sent
    expect(provider.starts.map(start => start.at)).toEqual(expected)
  })

  it("shares one schedule between Connections with the same bucket", async () => {
    const scheduler = createRequestScheduler()
    const provider = fakeFetch()
    const first = transport(provider.request, { bucket: "base", rate: { intervalMs: 100 } }, { name: "first", scheduler })
    const second = transport(provider.request, { bucket: "base", rate: { intervalMs: 100 } }, { name: "second", scheduler })
    const own = transport(provider.request, { rate: { intervalMs: 100 } }, { name: "own", scheduler })
    const sent = Promise.all([first.send(ITEMS, TOKEN, {}), second.send(ITEMS, TOKEN, {}), own.send(ITEMS, TOKEN, {})])
    await vi.runAllTimersAsync()
    await sent
    // The "own" Connection does not wait for the shared bucket.
    expect(provider.starts.map(start => start.at)).toEqual([0, 0, 100])
  })

  it("rejects conflicting intervals in a shared bucket", () => {
    const scheduler = createRequestScheduler()
    const provider = fakeFetch()
    transport(provider.request, { bucket: "base", rate: { intervalMs: 1000 } }, { name: "slow", scheduler })
    expect(() => transport(provider.request, { bucket: "base", rate: { intervalMs: 1 } }, { name: "fast", scheduler }))
      .toThrow('Connections sharing request bucket "base" must use the same rate interval.')
  })

  it("accepts equivalent intervals expressed with different rate forms", () => {
    const scheduler = createRequestScheduler()
    const provider = fakeFetch()
    transport(provider.request, { bucket: "base", rate: { intervalMs: 0.1 } }, { name: "decimal", scheduler })
    expect(() => transport(provider.request, { bucket: "base", rate: { limit: 7, perMs: 0.7 } }, { name: "ratio", scheduler }))
      .not.toThrow()
  })

  it("pauses the whole bucket after a 429 and retries every method after Retry-After", async () => {
    const scheduler = createRequestScheduler()
    const provider = fakeFetch([status(429, { "retry-after": "2" })])
    const policy: ConnectionRequestPolicy = { bucket: "base", retry: {} }
    const first = transport(provider.request, policy, { name: "first", scheduler })
    const second = transport(provider.request, policy, { name: "second", scheduler })
    const written = first.send(ITEMS, TOKEN, { body: "{}", method: "POST" })
    await vi.advanceTimersByTimeAsync(10)
    const read = second.send(ITEMS, TOKEN, { method: "GET" })
    await vi.advanceTimersByTimeAsync(1989)
    expect(provider.starts).toHaveLength(1)
    await vi.runAllTimersAsync()
    expect((await written).status).toBe(200)
    expect((await read).status).toBe(200)
    expect(provider.starts).toEqual([{ at: 0, method: "POST" }, { at: 2000, method: "POST" }, { at: 2000, method: "GET" }])
  })

  it("reads Retry-After as an HTTP date and keeps the minimum 429 pause", async () => {
    const provider = fakeFetch([
      status(429, { "retry-after": new Date(5000).toUTCString() }),
      status(429, { "retry-after": "1" }),
    ])
    const sent = transport(provider.request, { retry: { on429: { minDelayMs: 30_000 } } }).send(ITEMS, TOKEN, {})
    await vi.runAllTimersAsync()
    expect((await sent).status).toBe(200)
    expect(provider.starts.map(start => start.at)).toEqual([0, 30_000, 60_000])
  })

  it("retries 5xx responses only for the listed methods, with exponential backoff", async () => {
    const provider = fakeFetch([status(503), status(502), new Response("ok"), status(503)])
    const items = transport(provider.request, { retry: { attempts: 3 } })
    const read = items.send(ITEMS, TOKEN, { method: "get" })
    await vi.runAllTimersAsync()
    expect((await read).status).toBe(200)
    expect(provider.starts.map(start => start.at)).toEqual([0, 250, 750])

    const write = await items.send(ITEMS, TOKEN, { body: "{}", method: "POST" })
    expect(write.status).toBe(503)
    expect(provider.starts).toHaveLength(4)

    vi.setSystemTime(0)
    const posts = fakeFetch([status(500)])
    const listed = transport(posts.request, { retry: { delayMs: 100, methods: ["post"] } }).send(ITEMS, TOKEN, { method: "POST" })
    await vi.runAllTimersAsync()
    expect((await listed).status).toBe(200)
    expect(posts.starts.map(start => start.at)).toEqual([0, 100])
  })

  it("cancels discarded bodies and returns the last attempt as is", async () => {
    const cancelled: string[] = []
    const body = (text: string) => new ReadableStream({
      cancel: () => {
        cancelled.push(text)
      },
      start: controller => controller.enqueue(new TextEncoder().encode(text)),
    })
    const provider = fakeFetch([new Response(body("first"), { status: 503 }), new Response(body("last"), { status: 503 })])
    const sent = transport(provider.request, { retry: { attempts: 2 } }).send(ITEMS, TOKEN, {})
    await vi.runAllTimersAsync()
    const response = await sent
    expect(cancelled).toEqual(["first"])
    expect(response.status).toBe(503)
    expect(response.bodyUsed).toBe(false)
  })

  it("retries network errors only for the listed methods", async () => {
    const provider = fakeFetch([new TypeError("fetch failed"), new Response("ok"), new TypeError("fetch failed")])
    const items = transport(provider.request, { retry: {} })
    const read = items.send(ITEMS, TOKEN, {})
    await vi.runAllTimersAsync()
    expect((await read).status).toBe(200)
    expect(provider.starts).toHaveLength(2)

    await expect(items.send(ITEMS, TOKEN, { method: "POST" })).rejects.toThrow("fetch failed")
    expect(provider.starts).toHaveLength(3)
  })

  it("aborts each attempt after timeoutMs", async () => {
    const provider = fakeFetch(["hang", "hang"])
    const items = transport(provider.request, { retry: { attempts: 2, delayMs: 0 }, timeoutMs: 1000 })
    const sent = items.send(ITEMS, TOKEN, {})
    const failed = expect(sent).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(1000)
    expect(provider.starts).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1000)
    await failed
    expect(provider.starts.map(start => start.at)).toEqual([0, 1000])
  })

  it("stops at once when the caller aborts, without a retry", async () => {
    const provider = fakeFetch(["hang"])
    const items = transport(provider.request, { rate: { intervalMs: 1000 }, retry: { attempts: 5 }, timeoutMs: 10_000 })
    const caller = new AbortController()
    const sent = items.send(ITEMS, TOKEN, { signal: caller.signal })
    const failed = expect(sent).rejects.toBe("stopped")
    await vi.advanceTimersByTimeAsync(10)
    caller.abort("stopped")
    await failed
    expect(provider.starts).toHaveLength(1)

    const waiting = new AbortController()
    const queued = items.send(ITEMS, TOKEN, { signal: waiting.signal })
    const cancelled = expect(queued).rejects.toBe("gone")
    waiting.abort("gone")
    await cancelled
    expect(provider.starts).toHaveLength(1)
  })

  it("does not apply the policy to the provider's mcp endpoint", async () => {
    const provider = fakeFetch([status(503), status(503), "hang"])
    const items = transport(provider.request, { rate: { intervalMs: 1000 }, retry: {}, timeoutMs: 100 }, { mcp: "https://mcp.example.com/mcp" })
    const responses = await Promise.all([
      items.send("https://mcp.example.com/mcp", TOKEN, { method: "POST" }),
      items.send("https://mcp.example.com/mcp/", TOKEN, { method: "GET" }),
    ])
    expect(responses.map(response => response.status)).toEqual([503, 503])
    const stream = new AbortController()
    const open = items.send("https://mcp.example.com/mcp?session=1", TOKEN, { signal: stream.signal })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(provider.starts.map(start => start.at)).toEqual([0, 0, 0])
    stream.abort("closed")
    await expect(open).rejects.toBe("closed")

    const other = items.send("https://mcp.example.com/other", TOKEN, {})
    await vi.runAllTimersAsync()
    expect((await other).status).toBe(200)
    expect(provider.starts).toHaveLength(4)
  })
})

describe("Connection request policy definitions", () => {
  it.each<unknown>([
    { bucket: "" },
    { rate: { intervalMs: 0 } },
    { rate: { intervalMs: -1 } },
    { rate: { limit: 1.5, perMs: 1000 } },
    { rate: { intervalMs: 100, limit: 5 } },
    { retry: { attempts: 0 } },
    { retry: { delayMs: Number.POSITIVE_INFINITY } },
    { retry: { methods: ["GET /"] } },
    { retry: { on429: { minDelayMs: -1 } } },
    { retry: { attempt: 3 } },
    { timeoutMs: 0 },
    { timeout: 1000 },
  ])("rejects %o", (requests) => {
    // SAFETY: The test sends invalid values on purpose to check the definition schema.
    const policy = requests as ConnectionRequestPolicy
    expect(() => defineConnection({ provider: apiKey({ origins: ["https://api.example.com"], requests: policy }) })).toThrow(expect.objectContaining({ code: "CONNECTION_INVALID" }))
    expect(() => defineConnection({ provider: { ...testProvider(), requests: policy }, scopes: [] })).toThrow(expect.objectContaining({ code: "CONNECTION_INVALID" }))
  })

  it("accepts a full policy on both provider kinds", () => {
    const requests: ConnectionRequestPolicy = { bucket: "base", rate: { limit: 5, perMs: 1000 }, retry: { attempts: 4, delayMs: 0, methods: ["GET"], on429: { minDelayMs: 30_000 } }, timeoutMs: 15_000 }
    expect(defineConnection({ provider: apiKey({ origins: ["https://api.example.com"], requests }) }).provider.requests).toEqual(requests)
    expect(defineConnection({ provider: { ...testProvider(), requests }, scopes: [] }).provider.requests).toEqual(requests)
  })
})

it("applies the policy to Connection fetch calls", async () => {
  const provider = fakeFetch([status(503)])
  const runtime = createConnectionsRuntime({
    definitions: { items: defineConnection({ provider: apiKey({ origins: ["https://api.example.com"], requests: { retry: { delayMs: 0 } } }) }) },
    fetch: provider.request,
    store: createStore(),
  })
  await runtime.setKey({ key: "key-1", name: "items" })
  const response = await runtime.client("items", {}).fetch(ITEMS)
  expect(response.status).toBe(200)
  expect(provider.starts).toHaveLength(2)
})
