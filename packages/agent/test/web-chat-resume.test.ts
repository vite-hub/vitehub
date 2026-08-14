import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => vi.useRealTimers())

function chatRequest(method: "DELETE" | "GET" | "POST", owner = "max", messageId = "user-1"): Request {
  return new Request(`https://example.com/api/_vitehub/agents/support/chat${method === "POST" ? "" : "?id=chat-1"}`, {
    ...(method === "POST"
      ? { body: JSON.stringify({ id: "chat-1", messageId, messages: [{ id: messageId, parts: [{ text: "hello", type: "text" }], role: "user" }] }) }
      : {}),
    headers: { "content-type": "application/json", "x-owner": owner },
    method,
  })
}

describe("resumable web chat", () => {
  it("exposes bounded process-local route state for inspection", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: { portal: webChat({ route: { resumable: { owner: () => "max" } } }) },
      driver: { run: () => "done" },
    }) as never)
    const pending: Promise<unknown>[] = []

    await expect((await handler(chatRequest("POST"), { agentName: "support", waitUntil: promise => pending.push(promise) })).text()).resolves.toContain("done")
    await Promise.all(pending)

    expect(handler.inspect()).toMatchObject({
      activeRuns: 0,
      bufferedBytes: expect.any(Number),
      maxBufferedBytesPerOwner: 64 * 1024 * 1024,
      maxRunsPerOwner: 100,
      maxTotalRuns: 10_000,
      pendingClaims: 0,
      retainedRuns: 1,
    })
  })

  it("drops completed runs after the retention timeout and across handler restarts", async () => {
    vi.useFakeTimers()
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const agent = defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: { authenticate: ({ request }) => ({ owner: request.headers.get("x-owner") || "" }) },
            resumable: { owner: ({ auth }) => auth.owner },
          },
        }),
      },
      driver: { run: () => "Completed answer." },
    })
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }
    const handler = createChannelChatRouteHandler(agent as never)

    await expect((await handler(chatRequest("POST"), options)).text()).resolves.toContain("Completed answer.")
    await Promise.all(pending)
    await expect((await handler(chatRequest("GET"), options)).text()).resolves.toContain("Completed answer.")

    const restartedLookup = createChannelChatRouteHandler(agent as never)(chatRequest("GET"), options)
    await vi.advanceTimersByTimeAsync(3_000)
    expect((await restartedLookup).status).toBe(204)

    await vi.advanceTimersByTimeAsync(597_000)
    const expiredLookup = handler(chatRequest("GET"), options)
    await vi.advanceTimersByTimeAsync(3_000)
    expect((await expiredLookup).status).toBe(204)
  })

  it("registers before an immediate reconnect and deduplicates the same owner message", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    let releaseAuthentication!: () => void
    const authentication = new Promise<void>((resolve) => {
      releaseAuthentication = resolve
    })
    let releaseRun!: () => void
    const running = new Promise<void>((resolve) => {
      releaseRun = resolve
    })
    const run = vi.fn(async () => {
      await running
      return (async function* () {
        yield { text: "Recovered final answer.", type: "text-delta" }
        yield { type: "finish" }
      })()
    })
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: {
              async authenticate({ request }) {
                if (request.method === "POST") await authentication
                return { owner: request.headers.get("x-owner") || "" }
              },
            },
            resumable: { owner: ({ auth }) => auth.owner },
          },
        }),
      },
      driver: { run },
    }) as never)
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }

    const postPromise = handler(chatRequest("POST"), options)
    await Promise.resolve()
    const reconnectPromise = handler(chatRequest("GET"), options)
    releaseAuthentication()
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    const duplicatePromise = handler(chatRequest("POST"), options)
    releaseRun()

    const responses = await Promise.all([postPromise, reconnectPromise, duplicatePromise])
    expect(responses.map(response => response.status)).toEqual([200, 200, 200])
    const runIds = responses.map(response => response.headers.get("x-vitehub-run-id"))
    expect(runIds[0]).toBeTruthy()
    expect(new Set(runIds).size).toBe(1)
    const bodies = await Promise.all(responses.map(response => response.text()))
    expect(new Set(bodies).size).toBe(1)
    expect(bodies[0]).toContain("Recovered final answer.")
    expect(run).toHaveBeenCalledOnce()
    await Promise.all(pending)

    const completed = await handler(chatRequest("GET"), options)
    await expect(completed.text()).resolves.toBe(bodies[0])

    vi.useFakeTimers()
    const otherOwnerPromise = handler(chatRequest("GET", "other"), options)
    await vi.advanceTimersByTimeAsync(3_000)
    expect((await otherOwnerPromise).status).toBe(204)
  })

  it("keeps the newest POST as the latest replay when an older setup finishes later", async () => {
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    let releaseOlder!: () => void
    const olderSetup = new Promise<void>((resolve) => {
      releaseOlder = resolve
    })
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockImplementation(async (_agent, _context, _trigger, input) => {
      return new Response((input as { run?: { messageId?: string } }).run?.messageId === "user-new" ? "new" : "old")
    })
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: {
              authenticate: () => ({ owner: "max" }),
              async context({ body }) {
                if (body.messageId === "user-old") await olderSetup
              },
            },
            resumable: { owner: ({ auth }) => auth.owner },
          },
        }),
      },
      driver: { run: () => "unused" },
    }) as never)
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }

    try {
      const older = handler(chatRequest("POST", "max", "user-old"), options)
      await Promise.resolve()
      await expect((await handler(chatRequest("POST", "max", "user-new"), options)).text()).resolves.toBe("new")
      releaseOlder()
      await expect((await older).text()).resolves.toBe("old")
      await Promise.all(pending)
      await expect((await handler(chatRequest("GET"), options)).text()).resolves.toBe("new")
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })

  it("waits for a newer pending POST instead of replaying the previous completed run", async () => {
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    let releaseNewer!: () => void
    const newerSetup = new Promise<void>((resolve) => {
      releaseNewer = resolve
    })
    let invocations = 0
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockImplementation(async (_agent, _context, _trigger, input) => {
      return new Response((input as { run?: { messageId?: string } }).run?.messageId === "user-new" ? "new" : "old")
    })
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: { portal: webChat({ route: { resumable: { owner: () => "max" } } }) },
      driver: { run: () => "unused" },
      invoker: {
        async resolve() {
          if (++invocations === 2) await newerSetup
          return { id: "max" }
        },
      },
    }) as never)
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }

    try {
      await expect((await handler(chatRequest("POST", "max", "user-old"), options)).text()).resolves.toBe("old")
      await Promise.all(pending.splice(0))
      const newer = handler(chatRequest("POST", "max", "user-new"), options)
      await vi.waitFor(() => expect(invocations).toBe(2))
      const reconnect = handler(chatRequest("GET"), options)
      releaseNewer()
      await expect((await newer).text()).resolves.toBe("new")
      await expect((await reconnect).text()).resolves.toBe("new")
      await Promise.all(pending)
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })

  it("starts a new invocation when the AI SDK regenerates a retained message", async () => {
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockImplementation(async () => new Response("ok"))
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: { portal: webChat({ route: { resumable: { owner: () => "max" } } }) },
      driver: { run: () => "unused" },
    }) as never)
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }

    try {
      await expect((await handler(chatRequest("POST"), options)).text()).resolves.toBe("ok")
      const regeneration = new Request(chatRequest("POST"), {
        body: JSON.stringify({
          id: "chat-1",
          messageId: "user-1",
          messages: [{ id: "user-1", parts: [{ text: "hello", type: "text" }], role: "user" }],
          trigger: "regenerate-message",
        }),
      })
      await expect((await handler(regeneration, options)).text()).resolves.toBe("ok")
      await Promise.all(pending)
      expect(streamAgentTrigger).toHaveBeenCalledTimes(2)
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })

  it("replays buffered chunks to concurrent subscribers without detaching the original stream", async () => {
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    let source!: ReadableStreamDefaultController<Uint8Array>
    const sourceCancel = vi.fn()
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockResolvedValue(new Response(new ReadableStream({
      cancel: sourceCancel,
      start(controller) {
        source = controller
      },
    })))
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: { authenticate: ({ request }) => ({ owner: request.headers.get("x-owner") || "" }) },
            resumable: { owner: ({ auth }) => auth.owner },
          },
        }),
      },
      driver: { run: () => "unused" },
    }) as never)
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }

    try {
      const initial = await handler(chatRequest("POST"), options)
      const initialReader = initial.body!.getReader()
      source.enqueue(new TextEncoder().encode("first"))
      expect(new TextDecoder().decode((await initialReader.read()).value)).toBe("first")

      const reconnectPending: Promise<unknown>[] = []
      const reconnected = await handler(chatRequest("GET"), {
        agentName: "support",
        waitUntil: (promise: Promise<unknown>) => reconnectPending.push(promise),
      })
      expect(reconnectPending).toEqual(pending)
      const reconnectedReader = reconnected.body!.getReader()
      expect(new TextDecoder().decode((await reconnectedReader.read()).value)).toBe("first")
      expect(sourceCancel).not.toHaveBeenCalled()

      source.enqueue(new TextEncoder().encode("second"))
      expect(new TextDecoder().decode((await initialReader.read()).value)).toBe("second")
      expect(new TextDecoder().decode((await reconnectedReader.read()).value)).toBe("second")
      source.close()
      await expect(initialReader.read()).resolves.toEqual({ done: true, value: undefined })
      await expect(reconnectedReader.read()).resolves.toEqual({ done: true, value: undefined })
      await Promise.all(pending)
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })

  it("bounds concurrent live subscribers for one retained run", async () => {
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    let source!: ReadableStreamDefaultController<Uint8Array>
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        source = controller
      },
    })))
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: { portal: webChat({ route: { resumable: { owner: () => "max" } } }) },
      driver: { run: () => "unused" },
    }) as never)
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }

    try {
      const subscribers = [await handler(chatRequest("POST"), options)]
      for (let index = 1; index < 100; index++) subscribers.push(await handler(chatRequest("GET"), options))
      expect(handler.inspect()).toMatchObject({ activeRuns: 1, liveSubscribers: 100, maxSubscribersPerRun: 100 })
      expect((await handler(chatRequest("GET"), options)).status).toBe(429)
      source.close()
      await Promise.all(subscribers.map(response => response.text()))
      await Promise.all(pending)
      expect(handler.inspect()).toMatchObject({ activeRuns: 0, liveSubscribers: 0 })
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })

  it("fails and cancels a producer that exceeds the retained replay limit", async () => {
    vi.useFakeTimers()
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const cancel = vi.fn()
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockResolvedValueOnce(new Response(new ReadableStream({
      cancel,
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1))
      },
    }))).mockImplementation(async () => new Response("ok"))
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: { authenticate: () => ({ owner: "max" }) },
            resumable: { owner: ({ auth }) => auth.owner },
          },
        }),
      },
      driver: { run: () => "unused" },
    }) as never)
    const pending: Promise<unknown>[] = []

    try {
      const response = await handler(chatRequest("POST"), { agentName: "support", waitUntil: promise => pending.push(promise) })
      await expect(response.text()).rejects.toThrow("retained replay limit")
      await Promise.all(pending)
      expect(cancel).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1_000)
      const retry = await handler(chatRequest("POST"), { agentName: "support", waitUntil: promise => pending.push(promise) })
      await expect(retry.text()).resolves.toBe("ok")
      await vi.advanceTimersByTimeAsync(599_000)
      const deduplicated = await handler(chatRequest("POST"), { agentName: "support", waitUntil: promise => pending.push(promise) })
      await expect(deduplicated.text()).resolves.toBe("ok")
      expect(streamAgentTrigger).toHaveBeenCalledTimes(2)
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })

  it("evicts completed runs instead of rejecting new traffic at the retained-run limit", async () => {
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockImplementation(async () => new Response("ok"))
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: { portal: webChat({ route: { resumable: { owner: () => "max" } } }) },
      driver: { run: () => "unused" },
    }) as never)
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }

    try {
      for (let index = 0; index <= 100; index++) {
        await expect((await handler(chatRequest("POST", "max", `user-${index}`), options)).text()).resolves.toBe("ok")
      }
      await Promise.all(pending)
      expect(streamAgentTrigger).toHaveBeenCalledTimes(101)

      await expect((await handler(chatRequest("POST", "max", "user-100"), options)).text()).resolves.toBe("ok")
      expect(streamAgentTrigger).toHaveBeenCalledTimes(101)
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })

  it("does not evict another owner's replay or idempotent claim at the retained-run limit", async () => {
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockImplementation(async () => new Response("ok"))
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: { authenticate: ({ request }) => ({ owner: request.headers.get("x-owner") || "" }) },
            resumable: { owner: ({ auth }) => auth.owner },
          },
        }),
      },
      driver: { run: () => "unused" },
    }) as never)
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }

    try {
      await expect((await handler(chatRequest("POST", "other"), options)).text()).resolves.toBe("ok")
      for (let index = 0; index < 100; index++) {
        await expect((await handler(chatRequest("POST", "max", `user-${index}`), options)).text()).resolves.toBe("ok")
      }
      await Promise.all(pending)

      await expect((await handler(chatRequest("GET", "other"), options)).text()).resolves.toBe("ok")
      await expect((await handler(chatRequest("POST", "other"), options)).text()).resolves.toBe("ok")
      expect(streamAgentTrigger).toHaveBeenCalledTimes(101)
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })

  it("applies the retained-run limit per owner instead of rejecting a new owner", async () => {
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockImplementation(async () => new Response("ok"))
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: { authenticate: ({ request }) => ({ owner: request.headers.get("x-owner") || "" }) },
            resumable: { owner: ({ auth }) => auth.owner },
          },
        }),
      },
      driver: { run: () => "unused" },
    }) as never)
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }

    try {
      for (let index = 0; index <= 100; index++) {
        await expect((await handler(chatRequest("POST", `owner-${index}`), options)).text()).resolves.toBe("ok")
      }
      await Promise.all(pending)
      expect(streamAgentTrigger).toHaveBeenCalledTimes(101)
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })

  it("evicts completed replay buffers before enforcing the aggregate byte limit", async () => {
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockImplementation(async () => new Response(new Uint8Array(8 * 1024 * 1024)))
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: { portal: webChat({ route: { resumable: { owner: () => "max" } } }) },
      driver: { run: () => "unused" },
    }) as never)
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }

    try {
      for (let index = 0; index < 9; index++) {
        await expect((await handler(chatRequest("POST", "max", `user-${index}`), options)).arrayBuffer()).resolves.toHaveProperty("byteLength", 8 * 1024 * 1024)
      }
      await Promise.all(pending)
      expect(streamAgentTrigger).toHaveBeenCalledTimes(9)
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })

  it("releases a completed invocation when DELETE cancels its chat", async () => {
    vi.useFakeTimers()
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockImplementation(async () => new Response("ok"))
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: { portal: webChat({ route: { resumable: { owner: () => "max" } } }) },
      driver: { run: () => "unused" },
    }) as never)
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }

    try {
      await expect((await handler(chatRequest("POST"), options)).text()).resolves.toBe("ok")
      await Promise.all(pending)
      expect(vi.getTimerCount()).toBe(1)
      expect((await handler(chatRequest("DELETE"), options)).status).toBe(204)
      expect(vi.getTimerCount()).toBe(1)
      await expect((await handler(chatRequest("POST"), options)).text()).resolves.toBe("ok")
      expect(streamAgentTrigger).toHaveBeenCalledTimes(2)
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })

  it("cancels the detached producer only through DELETE", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    let releaseAuthentication!: () => void
    const authentication = new Promise<void>((resolve) => {
      releaseAuthentication = resolve
    })
    const cancel = vi.fn()
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: { async authenticate({ request }) {
              if (request.method === "POST") await authentication
              return { owner: request.headers.get("x-owner") || "" }
            } },
            resumable: { owner: ({ auth }) => auth.owner },
          },
        }),
      },
      driver: {
        run: () => ({
          toUIMessageStream: () => new ReadableStream({
            cancel,
            start(controller) {
              controller.enqueue({ messageId: "assistant-1", type: "start" })
            },
          }),
        }),
      },
    }) as never)
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }
    const responsePromise = handler(chatRequest("POST"), options)
    await Promise.resolve()
    releaseAuthentication()
    const response = await responsePromise
    const body = response.text()
    const cancellation = handler(chatRequest("DELETE"), options)

    expect((await cancellation).status).toBe(204)
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("Cancelled by the web chat client."))
    await expect(body).resolves.toContain("assistant-1")
    await Promise.all(pending)
  })

  it("aborts a registered invocation before its stream becomes ready", async () => {
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    let invocationSignal!: AbortSignal
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockImplementation(async (_agent, context) => {
      invocationSignal = (context as { request: Request }).request.signal
      await new Promise<void>((resolve) => invocationSignal.addEventListener("abort", () => resolve(), { once: true }))
      invocationSignal.throwIfAborted()
      return new Response("unreachable")
    })
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: { portal: webChat({ route: { resumable: { owner: () => "max" } } }) },
      driver: { run: () => "unused" },
    }) as never)
    const options = { agentName: "support", waitUntil: () => {} }

    try {
      const post = handler(chatRequest("POST"), options)
      await vi.waitFor(() => expect(streamAgentTrigger).toHaveBeenCalledOnce())
      await expect(handler(chatRequest("DELETE"), options)).resolves.toMatchObject({ status: 204 })
      expect(invocationSignal.aborted).toBe(true)
      await expect(post).resolves.toMatchObject({ status: 500 })
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })

  it("preserves DELETE cancellation while a POST is still registering", async () => {
    vi.useFakeTimers()
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    let releaseAuthentication!: () => void
    const authentication = new Promise<void>((resolve) => {
      releaseAuthentication = resolve
    })
    const run = vi.fn(() => "unused")
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: { async authenticate({ request }) {
              if (request.method === "POST") await authentication
              return { owner: request.headers.get("x-owner") || "" }
            } },
            resumable: { owner: ({ auth }) => auth.owner },
          },
        }),
      },
      driver: { run },
    }) as never)
    const options = { agentName: "support", waitUntil: () => {} }

    const posts = [handler(chatRequest("POST"), options), handler(chatRequest("POST"), options)]
    await Promise.resolve()
    const cancellation = handler(chatRequest("DELETE"), options)
    await vi.advanceTimersByTimeAsync(3_000)
    expect((await cancellation).status).toBe(204)
    releaseAuthentication()
    await expect(Promise.all(posts)).resolves.toMatchObject([{ status: 204 }, { status: 204 }])
    expect(run).not.toHaveBeenCalled()
  })

  it("bounds DELETE while a known POST claim remains stalled", async () => {
    vi.useFakeTimers()
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    let releaseInvoker!: () => void
    const invoker = new Promise<void>((resolve) => {
      releaseInvoker = resolve
    })
    let resolving = false
    const run = vi.fn(() => "unused")
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: { portal: webChat({ route: { resumable: { owner: () => "max" } } }) },
      driver: { run },
      invoker: {
        async resolve() {
          resolving = true
          await invoker
          return { id: "max" }
        },
      },
    }) as never)
    const options = { agentName: "support", waitUntil: () => {} }

    const post = handler(chatRequest("POST"), options)
    await vi.waitFor(() => expect(resolving).toBe(true))
    const cancellation = handler(chatRequest("DELETE"), options)
    await vi.advanceTimersByTimeAsync(3_000)
    expect((await cancellation).status).toBe(204)
    releaseInvoker()
    expect((await post).status).toBe(204)
    expect(run).not.toHaveBeenCalled()
  })

  it("does not cancel a newer POST that registers during DELETE lookup", async () => {
    vi.useFakeTimers()
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockImplementation(async () => new Response("ok"))
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: { portal: webChat({ route: { resumable: { owner: () => "max" } } }) },
      driver: { run: () => "unused" },
    }) as never)
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }

    try {
      const cancellation = handler(chatRequest("DELETE"), options)
      await Promise.resolve()
      await expect((await handler(chatRequest("POST"), options)).text()).resolves.toBe("ok")
      await vi.advanceTimersByTimeAsync(100)
      expect((await cancellation).status).toBe(204)
      await Promise.all(pending)
      await expect((await handler(chatRequest("GET"), options)).text()).resolves.toBe("ok")
      expect(streamAgentTrigger).toHaveBeenCalledOnce()
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })

  it.each([
    [new Error("stream exploded"), "stream exploded"],
    ["string exploded", "string exploded"],
    [undefined, "Resumable web chat failed"],
  ])("replays unexpected stream errors to reconnecting clients", async (failure, message) => {
    const agentModule = await import("../src/index.ts")
    const { defineAgent } = agentModule
    const { webChat } = await import("../src/channels.ts")
    const { createChannelChatRouteHandler } = await import("../src/server/internal.ts")
    const streamAgentTrigger = vi.spyOn(agentModule, "streamAgentTrigger").mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.error(failure)
      },
    })))
    const handler = createChannelChatRouteHandler(defineAgent({
      channels: {
        portal: webChat({
          route: {
            admission: { authenticate: ({ request }) => ({ owner: request.headers.get("x-owner") || "" }) },
            resumable: { owner: ({ auth }) => auth.owner },
          },
        }),
      },
      driver: { run: () => "unused" },
    }) as never)
    const pending: Promise<unknown>[] = []
    const options = { agentName: "support", waitUntil: (promise: Promise<unknown>) => pending.push(promise) }

    try {
      const response = await handler(chatRequest("POST"), options)
      await expect(response.text()).rejects.toThrow(message)
      await Promise.all(pending)

      const replay = await handler(chatRequest("GET"), options)
      await expect(replay.text()).rejects.toThrow(message)
      expect(streamAgentTrigger).toHaveBeenCalledOnce()
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })
})
