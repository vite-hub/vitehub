import { afterEach, describe, expect, it, vi } from "vitest"

import { defineChatCapability } from "../src/chat-trigger.ts"
import { defineAgent } from "../src/index.ts"
import { createResumableChatProcessCustody } from "../src/internal/resumable-chat.ts"
import { createChannelChatRouteHandler } from "../src/server/internal.ts"

import type { ResumableChatProcessClaim } from "../src/internal/resumable-chat.ts"

function chatRequest(
  method: "DELETE" | "GET" | "POST",
  user: string,
  body?: Record<string, unknown>,
  messageId = "message-1",
): Request {
  const url = method === "POST"
    ? "https://example.com/api/_vitehub/agents/support/chat"
    : `https://example.com/api/_vitehub/agents/support/chat?id=chat-1${method === "DELETE" ? `&messageId=${messageId}` : ""}`
  return new Request(url, {
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", "x-user": user },
    method,
  })
}

function chatBody(messageId = "message-1"): Record<string, unknown> {
  return {
    id: "chat-1",
    messageId,
    messages: [{ id: messageId, parts: [{ text: "hello", type: "text" }], role: "user" }],
  }
}

function resumableHandler(run: () => Response | Promise<Response>) {
  return createChannelChatRouteHandler(
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    defineAgent({ capabilities: [defineChatCapability()], driver: { run } }) as never,
    {
      admission: { authenticate: ({ request }) => request.headers.get("x-user") || false },
      resumable: { owner: ({ auth }) => String(auth), scope: "process" },
    },
  )
}

function processCustody(ttlMs?: number) {
  return createResumableChatProcessCustody<{ auth: string }>({
    owner: ({ auth }) => auth,
    scope: "process",
    ttlMs,
  })
}

async function processSession(custody = processCustody(), auth = "user-1") {
  return await custody.session(
    { auth },
    { agentName: "support", channelId: "http", chatId: "chat-1" },
  )
}

function expectClaimed(
  result: ReturnType<Awaited<ReturnType<typeof processSession>>["claim"]>,
): ResumableChatProcessClaim {
  expect(result.kind).toBe("claimed")
  if (result.kind !== "claimed") throw new Error("Expected a new resumable Chat claim.")
  return result
}

afterEach(() => {
  vi.useRealTimers()
})

describe("resumable Chat process custody", () => {
  it("replays bodyless and HTTP error responses with stable metadata", async () => {
    const session = await processSession()
    const bodyless = expectClaimed(session.claim("message-1"))
    const bodylessResponse = bodyless.complete(new Response(null, { status: 204 }), {
      messageId: "message-1",
      runId: "run-1",
      waitUntil: vi.fn(),
    })

    expect(bodylessResponse.status).toBe(204)
    expect(bodylessResponse.body).toBeNull()
    expect(bodylessResponse.headers.get("x-vitehub-message-id")).toBe("message-1")
    const bodylessDuplicate = session.claim("message-1")
    expect(bodylessDuplicate.kind).toBe("existing")
    if (bodylessDuplicate.kind === "existing") {
      await expect(bodylessDuplicate.response).resolves.toMatchObject({ status: 204 })
    }

    const tasks: Promise<unknown>[] = []
    const failed = expectClaimed(session.claim("message-2"))
    failed.complete(
      new Response("unavailable", {
        headers: { "content-length": "11", "x-origin": "agent" },
        status: 503,
        statusText: "Unavailable",
      }),
      {
        messageId: "message-2",
        runId: "run-2",
        waitUntil: promise => tasks.push(promise),
      },
    )
    await Promise.all(tasks)
    const replay = session.claim("message-2")
    expect(replay.kind).toBe("existing")
    if (replay.kind === "existing") {
      const response = await replay.response
      expect(response.status).toBe(503)
      expect(response.statusText).toBe("Unavailable")
      expect(response.headers.get("content-length")).toBeNull()
      expect(response.headers.get("x-origin")).toBe("agent")
      await expect(response.text()).resolves.toBe("unavailable")
    }

    await session.stop("message-1")
    await session.stop("message-2")
  })

  it("keeps the producer alive when one subscriber cancels and fans producer failures out", async () => {
    const session = await processSession()
    let source!: ReadableStreamDefaultController<Uint8Array>
    const sourceCancelled = vi.fn()
    const tasks: Promise<unknown>[] = []
    const claim = expectClaimed(session.claim("message-1"))
    const response = claim.complete(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel: sourceCancelled,
          start(controller) {
            source = controller
          },
        }),
      ),
      {
        messageId: "message-1",
        runId: "run-1",
        waitUntil: promise => tasks.push(promise),
      },
    )

    await response.body!.cancel("browser disconnected")
    expect(sourceCancelled).not.toHaveBeenCalled()
    const duplicate = session.claim("message-1")
    expect(duplicate.kind).toBe("existing")
    if (duplicate.kind !== "existing") throw new Error("Expected the active claim.")
    const replay = await duplicate.response
    const replayBody = replay.text()
    source.enqueue(new TextEncoder().encode("partial"))
    source.error(new Error("producer failed"))

    await Promise.all(tasks)
    await expect(replayBody).rejects.toThrow("producer failed")
    const terminal = session.claim("message-1")
    if (terminal.kind !== "existing") throw new Error("Expected the terminal claim.")
    await expect((await terminal.response).text()).rejects.toThrow("producer failed")
    await session.stop("message-1")
  })

  it("isolates owners and custody instances", async () => {
    const custody = processCustody()
    const owner = await processSession(custody, "user-1")
    const otherOwner = await processSession(custody, "user-2")
    const otherProcess = await processSession(processCustody(), "user-1")
    const ownerClaim = expectClaimed(owner.claim("message-1"))
    ownerClaim.complete(new Response(null, { status: 204 }), {
      messageId: "message-1",
      runId: "run-1",
      waitUntil: vi.fn(),
    })

    const otherOwnerClaim = expectClaimed(otherOwner.claim("message-1"))
    const otherProcessClaim = expectClaimed(otherProcess.claim("message-1"))
    otherOwnerClaim.fail(new Error("test cleanup"))
    otherProcessClaim.fail(new Error("test cleanup"))
    await owner.stop("message-1")
  })

  it("times out latest-run discovery without retaining polling timers", async () => {
    vi.useFakeTimers()
    const session = await processSession()
    const latest = session.latest()

    await vi.advanceTimersByTimeAsync(3_000)

    await expect(latest).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("expires terminal claims at custom and default TTLs without leaking timers", async () => {
    vi.useFakeTimers()
    const custom = await processSession(processCustody(50))
    const customClaim = expectClaimed(custom.claim("message-1"))
    customClaim.complete(new Response(null, { status: 204 }), {
      messageId: "message-1",
      runId: "run-1",
      waitUntil: vi.fn(),
    })
    expect(custom.claim("message-1").kind).toBe("existing")
    await vi.advanceTimersByTimeAsync(50)
    const customReplacement = expectClaimed(custom.claim("message-1"))
    customReplacement.fail(new Error("test cleanup"))

    const defaults = await processSession()
    const defaultClaim = expectClaimed(defaults.claim("message-1"))
    defaultClaim.complete(new Response(null, { status: 204 }), {
      messageId: "message-1",
      runId: "run-1",
      waitUntil: vi.fn(),
    })
    await vi.advanceTimersByTimeAsync(599_999)
    expect(defaults.claim("message-1").kind).toBe("existing")
    await vi.advanceTimersByTimeAsync(1)
    const defaultReplacement = expectClaimed(defaults.claim("message-1"))
    defaultReplacement.fail(new Error("test cleanup"))

    expect(vi.getTimerCount()).toBe(0)
  })

  it("shares setup errors with duplicates, then releases the failed claim", async () => {
    const session = await processSession()
    const claim = expectClaimed(session.claim("message-1"))
    const duplicate = session.claim("message-1")
    if (duplicate.kind !== "existing") throw new Error("Expected the active claim.")
    claim.fail(new Error("setup failed"))

    await expect(duplicate.response).rejects.toThrow("setup failed")
    const retry = expectClaimed(session.claim("message-1"))
    retry.fail(new Error("test cleanup"))
  })

  it("stops active producers, removes both indexes, and leaves no cleanup timer", async () => {
    vi.useFakeTimers()
    const session = await processSession()
    const cancelled = vi.fn()
    const tasks: Promise<unknown>[] = []
    const claim = expectClaimed(session.claim("message-1"))
    const response = claim.complete(
      new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })),
      {
        messageId: "message-1",
        runId: "run-1",
        waitUntil: promise => tasks.push(promise),
      },
    )
    await response.body!.cancel("browser disconnected")

    await session.stop("message-1")
    await Promise.all(tasks)

    expect(cancelled).toHaveBeenCalledWith("Cancelled by the web chat client.")
    expect(vi.getTimerCount()).toBe(0)
    const retry = expectClaimed(session.claim("message-1"))
    retry.fail(new Error("test cleanup"))
  })
})

describe("resumable Agent chat routes", () => {
  it("invokes duplicate POSTs once and replays the stream only to its authenticated owner", async () => {
    const encoder = new TextEncoder()
    let source!: ReadableStreamDefaultController<Uint8Array>
    const run = vi.fn(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
      },
    }), { headers: { "content-type": "text/plain" } }))
    const handler = resumableHandler(run)

    const first = await handler(chatRequest("POST", "user-1", chatBody()), { agentName: "support" })
    await first.body!.cancel("browser disconnected")
    const duplicate = await handler(chatRequest("POST", "user-1", chatBody()), { agentName: "support" })
    const replay = await handler(chatRequest("GET", "user-1"), { agentName: "support" })
    const otherOwner = await handler(chatRequest("DELETE", "user-2"), { agentName: "support" })

    expect(otherOwner.status).toBe(204)
    expect(run).toHaveBeenCalledOnce()
    expect(duplicate.headers.get("x-vitehub-run-id")).toBeTruthy()
    expect(replay.headers.get("x-vitehub-message-id")).toBe("message-1")
    expect(replay.headers.get("x-vitehub-run-id")).toBe(duplicate.headers.get("x-vitehub-run-id"))

    const duplicateBody = duplicate.text()
    source.enqueue(encoder.encode("first "))
    const replayBody = replay.text()
    source.enqueue(encoder.encode("second"))
    source.close()

    await expect(duplicateBody).resolves.toBe("first second")
    await expect(replayBody).resolves.toBe("first second")
  })

  it("cancels and removes a run only for its authenticated owner", async () => {
    const cancelled = vi.fn()
    const run = vi.fn(() => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), {
      headers: { "content-type": "text/plain" },
    }))
    const handler = resumableHandler(run)

    const first = await handler(chatRequest("POST", "user-1", chatBody()), { agentName: "support" })
    await first.body!.cancel("browser disconnected")
    const cancelledResponse = await handler(chatRequest("DELETE", "user-1"), { agentName: "support" })

    expect(cancelledResponse.status).toBe(204)
    expect(cancelled).toHaveBeenCalledWith("Cancelled by the web chat client.")

    const restarted = await handler(chatRequest("POST", "user-1", chatBody()), { agentName: "support" })
    expect(restarted.status).toBe(200)
    expect(run).toHaveBeenCalledTimes(2)
    await handler(chatRequest("DELETE", "user-1"), { agentName: "support" })
  })

  it("does not let a stale stop cancel the owner's newer run", async () => {
    const cancelledA = vi.fn()
    const cancelledB = vi.fn()
    const run = vi.fn()
      .mockImplementationOnce(() => new Response(new ReadableStream<Uint8Array>({ cancel: cancelledA })))
      .mockImplementationOnce(() => new Response(new ReadableStream<Uint8Array>({ cancel: cancelledB })))
    const handler = resumableHandler(run)

    const first = await handler(chatRequest("POST", "user-1", chatBody("message-a")), { agentName: "support" })
    await first.body!.cancel("browser disconnected")
    const second = await handler(chatRequest("POST", "user-1", chatBody("message-b")), { agentName: "support" })
    await second.body!.cancel("browser disconnected")

    await handler(chatRequest("DELETE", "user-1", undefined, "message-a"), { agentName: "support" })

    expect(cancelledA).toHaveBeenCalledWith("Cancelled by the web chat client.")
    expect(cancelledB).not.toHaveBeenCalled()
    await handler(chatRequest("DELETE", "user-1", undefined, "message-b"), { agentName: "support" })
  })

  it("fences cancellation with the client message when input mapping changes run metadata", async () => {
    const cancelled = vi.fn()
    const run = vi.fn(() => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })))
    const handler = createChannelChatRouteHandler(
      // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
      defineAgent({ capabilities: [defineChatCapability()], driver: { run } }) as never,
      {
        admission: { authenticate: ({ request }) => request.headers.get("x-user") || false },
        mapInput: () => ({ run: { messageId: "mapped-message" } }),
        resumable: { owner: ({ auth }) => String(auth), scope: "process" },
      },
    )

    const response = await handler(chatRequest("POST", "user-1", chatBody("client-message")), { agentName: "support" })
    await response.body!.cancel("browser disconnected")
    await handler(chatRequest("DELETE", "user-1", undefined, "client-message"), { agentName: "support" })

    expect(cancelled).toHaveBeenCalledWith("Cancelled by the web chat client.")
  })

  it("does not share resumable claims across generated handler instances", async () => {
    const run = vi.fn(() => new Response("done"))
    const firstHandler = resumableHandler(run)
    const secondHandler = resumableHandler(run)

    await firstHandler(chatRequest("POST", "user-1", chatBody()), { agentName: "support" })
    await secondHandler(chatRequest("POST", "user-1", chatBody()), { agentName: "support" })

    expect(run).toHaveBeenCalledTimes(2)
  })

  it("rejects resumable routes that do not name their process scope", async () => {
    const run = vi.fn(() => new Response("done"))
    const handler = createChannelChatRouteHandler(
      // SAFETY: This fixture deliberately bypasses types to verify the JavaScript runtime boundary.
      defineAgent({ capabilities: [defineChatCapability()], driver: { run } }) as never,
      {
        admission: { authenticate: ({ request }) => request.headers.get("x-user") || false },
        // @ts-expect-error This fixture verifies the required scope at runtime.
        resumable: { owner: ({ auth }) => String(auth) },
      },
    )

    const response = await handler(chatRequest("POST", "user-1", chatBody()), { agentName: "support" })

    expect(response.status).toBe(400)
    expect(run).not.toHaveBeenCalled()
  })

  it("shares setup failures with duplicates and permits a clean retry", async () => {
    let fail!: (error: Error) => void
    const pending = new Promise<Response>((_resolve, reject) => {
      fail = reject
    })
    const run = vi.fn<() => Response | Promise<Response>>()
      .mockImplementationOnce(() => pending)
      .mockImplementationOnce(() => new Response("recovered", { headers: { "content-type": "text/plain" } }))
    const handler = resumableHandler(run)

    const first = handler(chatRequest("POST", "user-1", chatBody()), { agentName: "support" })
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    const duplicate = handler(chatRequest("POST", "user-1", chatBody()), { agentName: "support" })
    fail(new Error("setup failed"))

    await expect(first).resolves.toMatchObject({ status: 500 })
    await expect(duplicate).resolves.toMatchObject({ status: 500 })
    expect(run).toHaveBeenCalledOnce()

    const retried = await handler(chatRequest("POST", "user-1", chatBody()), { agentName: "support" })
    await expect(retried.text()).resolves.toBe("recovered")
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("keeps non-resumable chat routes POST-only", async () => {
    const handler = createChannelChatRouteHandler(
      // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
      defineAgent({ capabilities: [defineChatCapability()], driver: { run: () => "done" } }) as never,
    )

    const response = await handler(chatRequest("GET", "user-1"), { agentName: "support" })

    expect(response.status).toBe(405)
  })
})
