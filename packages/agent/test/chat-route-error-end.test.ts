import { describe, expect, it, vi } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { defineChatCapability } from "../src/chat-trigger.ts"
import { toAgentUiMessageStreamResponse } from "../src/http-response.ts"
import { defineAgent } from "../src/index.ts"
import { createChannelChatRouteHandler } from "../src/server/internal.ts"
import { createAgentUIMessageStreamResponse } from "../src/stream-output.ts"

const chatBody = JSON.stringify({ id: "chat-1", messages: [{ id: "message-1", parts: [{ text: "hello", type: "text" }], role: "user" }] })

/** A UI message stream that sends a recoverable tool error and then fails. */
function failingParts(): ReadableStream<unknown> {
  let sent = false
  return new ReadableStream({
    pull(controller) {
      if (sent) return controller.error(new Error("Provider connection closed."))
      sent = true
      controller.enqueue({ output: { message: "Not found.", type: "error" }, toolCallId: "call-1", type: "tool-output-available" })
    },
  })
}

function failingSseResponse(): Response {
  const encoder = new TextEncoder()
  let sent = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return controller.error(new Error("Provider connection closed."))
      sent = true
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ output: { message: "Not found.", type: "error" }, toolCallId: "call-1", type: "tool-output-available" })}\n\n`))
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } })
}

describe("Agent chat route errors", () => {
  it("ends the response after it sends the error frame", async () => {
    const handler = createChannelChatRouteHandler(
      // SAFETY: The minimal Agent definition exercises only the route's UI message stream.
      defineAgent({ capabilities: [defineChatCapability()], driver: { run: () => (async function* () {
        yield { error: agentDiagnostics.AGENT_R1016({ connection: "chatgpt", problem: "sign-in" }), type: "error" }
      })() } }) as never,
    )
    const body = JSON.stringify({ id: "chat-1", messages: [{ id: "message-1", parts: [{ text: "hello", type: "text" }], role: "user" }] })
    // SAFETY: agentName is the only route option this test needs.
    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", { body, headers: { "content-type": "application/json" }, method: "POST" }), { agentName: "support" } as never)

    // The body ends with [DONE] after the error frame, so the client reads a complete stream.
    const text = await response.text()
    expect(text).toContain('"errorText":"AGENT_R1016: The ChatGPT Connection cannot provide plan access (sign-in).","type":"error"')
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true)
  })

  it("names the ChatGPT gateway diagnostic when a model-backed Driver fails in the stream", async () => {
    const failing = async () => { throw agentDiagnostics.AGENT_R1016({ connection: "chatgpt", problem: "sign-in" }) }
    const model = { specificationVersion: "v4" as const, provider: "chatgpt", modelId: "gpt-5.5", supportedUrls: {}, doGenerate: failing, doStream: failing }
    const handler = createChannelChatRouteHandler(
      // SAFETY: The minimal Agent definition exercises only the route's UI message stream.
      defineAgent({ capabilities: [defineChatCapability()], driver: { model } }) as never,
    )
    // SAFETY: agentName is the only route option this test needs.
    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", { body: chatBody, headers: { "content-type": "application/json" }, method: "POST" }), { agentName: "support" } as never)
    expect(await response.text()).toContain('"errorText":"AGENT_R1016: The ChatGPT Connection cannot provide plan access (sign-in)."')
  })

  it("names the ChatGPT gateway diagnostic when it fails before the stream starts", async () => {
    const handler = createChannelChatRouteHandler(
      // SAFETY: The minimal Agent definition exercises only the route's error response.
      defineAgent({ capabilities: [defineChatCapability()], driver: { run: () => {
        throw agentDiagnostics.AGENT_R1016({ connection: "chatgpt", problem: "sign-in" })
      } } }) as never,
    )
    const body = JSON.stringify({ id: "chat-1", messages: [{ id: "message-1", parts: [{ text: "hello", type: "text" }], role: "user" }] })
    // SAFETY: agentName is the only route option this test needs.
    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", { body, headers: { "content-type": "application/json" }, method: "POST" }), { agentName: "support" } as never)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      code: "PROVIDER_UNAVAILABLE",
      error: "AGENT_R1016: The ChatGPT Connection cannot provide plan access (sign-in).",
    })
  })

  it("reports a failure after a tool output that contains an error object", async () => {
    const deliveryLog = vi.spyOn(console, "info").mockImplementation(() => {})
    const handler = createChannelChatRouteHandler(
      // SAFETY: The minimal Agent definition exercises only the route's UI message stream.
      defineAgent({ capabilities: [defineChatCapability()], driver: { run: () => failingSseResponse() } }) as never,
    )
    // SAFETY: agentName is the only route option this test needs.
    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", { body: chatBody, headers: { "content-type": "application/json" }, method: "POST" }), { agentName: "support" } as never)

    const text = await response.text()
    expect(text).toContain('"type":"tool-output-available"')
    expect(text).toContain('{"errorText":"Provider connection closed.","type":"error"}')
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true)
    await vi.waitFor(() => expect(deliveryLog.mock.calls.map(([line]): unknown => JSON.parse(String(line))))
      .toContainEqual(expect.objectContaining({ error: "Provider connection closed.", type: "failed" })))
    deliveryLog.mockRestore()
  })

  it.each([
    ["createAgentUIMessageStreamResponse", () => createAgentUIMessageStreamResponse({ stream: failingParts() })],
    ["toAgentUiMessageStreamResponse", () => toAgentUiMessageStreamResponse({ stream: failingParts() })],
  ])("%s ends the response with an error frame when its stream fails", async (_name, encode) => {
    // The encoder ends the body itself, so the client reads the error and a complete stream.
    const text = await encode().text()
    expect(text.split("\n\n").filter(Boolean)).toEqual([
      `data: ${JSON.stringify({ output: { message: "Not found.", type: "error" }, toolCallId: "call-1", type: "tool-output-available" })}`,
      'data: {"errorText":"Provider connection closed.","type":"error"}',
      "data: [DONE]",
    ])
  })
})
