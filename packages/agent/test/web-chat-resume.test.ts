import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => vi.useRealTimers())

const chatBody = JSON.stringify({
  id: "chat-1",
  messageId: "user-1",
  messages: [{ id: "user-1", parts: [{ text: "hello", type: "text" }], role: "user" }],
})

function chatRequest(method: "DELETE" | "GET" | "POST", owner = "max"): Request {
  return new Request(`https://example.com/api/_vitehub/agents/support/chat${method === "POST" ? "" : "?id=chat-1"}`, {
    ...(method === "POST" ? { body: chatBody } : {}),
    headers: { "content-type": "application/json", "x-owner": owner },
    method,
  })
}

describe("resumable web chat", () => {
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

  it("replays buffered chunks before continuing the live stream after subscriber disposal", async () => {
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
      await expect(initialReader.read()).resolves.toEqual({ done: true, value: undefined })
      expect(sourceCancel).not.toHaveBeenCalled()

      source.enqueue(new TextEncoder().encode("second"))
      expect(new TextDecoder().decode((await reconnectedReader.read()).value)).toBe("second")
      source.close()
      await expect(reconnectedReader.read()).resolves.toEqual({ done: true, value: undefined })
      await Promise.all(pending)
    }
    finally {
      streamAgentTrigger.mockRestore()
    }
  })

  it("fails and cancels a producer that exceeds the retained replay limit", async () => {
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
    }))).mockResolvedValueOnce(new Response("ok"))
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
      const retry = await handler(chatRequest("POST"), { agentName: "support", waitUntil: promise => pending.push(promise) })
      await expect(retry.text()).resolves.toBe("ok")
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
    const cancellation = handler(chatRequest("DELETE"), options)
    releaseAuthentication()
    const response = await responsePromise
    const body = response.text()

    expect((await cancellation).status).toBe(204)
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("Cancelled by the web chat client."))
    await expect(body).resolves.toContain("assistant-1")
    await Promise.all(pending)
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
