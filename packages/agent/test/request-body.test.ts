import { createHmac } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import { defineAgent } from "../src/index.ts"
import { createChannelChatRouteHandler } from "../src/server/internal.ts"
import { captureAgentInboundBody, maximumAgentInboundBodyBytes } from "../src/server/request-body.ts"
import { verifyAgentWebhookRequest } from "../src/trigger-runtime.ts"

const encoder = new TextEncoder()

function streamingRequest(chunks: string[], headers?: Record<string, string>) {
  const cancel = vi.fn()
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    cancel,
    pull(controller) {
      const value = chunks[index++]
      if (value === undefined) controller.close()
      else controller.enqueue(encoder.encode(value))
    },
  })
  const request = new Request("https://example.com/webhook", {
    body,
    headers,
    method: "POST",
    // Node requires duplex for a streamed request body. Workers and Vercel expose the same Request interface without it.
    duplex: "half",
  } as RequestInit & { duplex: "half" })
  return { cancel, request }
}

describe("Agent inbound request bodies", () => {
  it.each([
    ["Node", {}],
    ["Cloudflare", { cloudflare: { env: {} } }],
    ["Vercel", { runtime: "vercel" }],
  ])("rejects a declared body larger than the route limit on the %s Request path", async (_host, runtimeOptions) => {
    const body = JSON.stringify({ messages: [{ id: "message-1", parts: [{ text: "hello", type: "text" }], role: "user" }] })
    const run = vi.fn(() => "unused")
    const handler = createChannelChatRouteHandler(defineAgent({ driver: { run } }) as never)
    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body,
      headers: { "content-length": String(body.length), "content-type": "application/json" },
      method: "POST",
    }), { agentName: "support", maxBodyBytes: body.length - 1, ...runtimeOptions } as never)

    expect(response.status).toBe(413)
    expect(run).not.toHaveBeenCalled()
  })

  it("accepts an exact Content-Length and preserves the captured bytes", async () => {
    const raw = "{\"value\":\"ø\"}"
    const bytes = encoder.encode(raw)
    const captured = await captureAgentInboundBody(new Request("https://example.com/webhook", {
      body: bytes,
      headers: { "content-length": String(bytes.byteLength) },
      method: "POST",
    }), bytes.byteLength)

    expect(captured.bytes).toEqual(bytes)
    expect(captured.text).toBe(raw)
    await expect(captured.request.arrayBuffer()).resolves.toEqual(bytes.buffer)
  })

  it.each([
    ["absent", undefined],
    ["lying", "1"],
  ])("counts a chunked body when Content-Length is %s", async (_case, contentLength) => {
    const { cancel, request } = streamingRequest(["12", "34"], contentLength ? { "content-length": contentLength } : undefined)
    await expect(captureAgentInboundBody(request, 3)).rejects.toMatchObject({ statusCode: 413 })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("cancels a slow stream when the client aborts", async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    let timer: ReturnType<typeof setTimeout> | undefined
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) {
        if (timer) clearTimeout(timer)
        cancel(reason)
      },
      pull(stream) {
        timer = setTimeout(() => stream.enqueue(encoder.encode("later")), 100)
      },
    })
    const request = new Request("https://example.com/webhook", {
      body,
      method: "POST",
      signal: controller.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" })
    const captured = captureAgentInboundBody(request, 100)
    controller.abort(new Error("client disconnected"))

    await expect(captured).rejects.toThrow("client disconnected")
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("rejects malformed JSON after the bounded capture", async () => {
    const handler = createChannelChatRouteHandler(defineAgent({ driver: { run: () => "unused" } }) as never)
    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      body: "{not-json",
      method: "POST",
    }), { maxBodyBytes: 100 } as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: "Malformed agent chat payload." })
  })

  it("verifies GitHub signatures against the original bytes", async () => {
    const secret = "secret-token"
    const bytes = new Uint8Array([0xff, 0x00, 0x61])
    const signature = `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`
    const request = new Request("https://example.com/webhook", {
      body: bytes,
      headers: { "x-hub-signature-256": signature },
      method: "POST",
    })

    await expect(verifyAgentWebhookRequest([{
      id: "github",
      provider: "github",
      secretHeader: "x-hub-signature-256",
      secretToken: secret,
      signature: "github-sha256",
    }], request)).resolves.toMatchObject({ verified: true })
  })

  it("rejects limits above the package safety ceiling", async () => {
    await expect(captureAgentInboundBody(new Request("https://example.com", { method: "POST" }), maximumAgentInboundBodyBytes + 1))
      .rejects.toThrow("maxBodyBytes")
  })
})
