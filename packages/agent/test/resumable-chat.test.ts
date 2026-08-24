import { describe, expect, it, vi } from "vitest"

import { defineChatCapability } from "../src/chat-trigger.ts"
import { defineAgent } from "../src/index.ts"
import { createChannelChatRouteHandler } from "../src/server/internal.ts"

function chatRequest(method: "DELETE" | "GET" | "POST", user: string, body?: Record<string, unknown>): Request {
  const url = method === "POST"
    ? "https://example.com/api/_vitehub/agents/support/chat"
    : "https://example.com/api/_vitehub/agents/support/chat?id=chat-1"
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
      resumable: { owner: ({ auth }) => String(auth) },
    },
  )
}

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
