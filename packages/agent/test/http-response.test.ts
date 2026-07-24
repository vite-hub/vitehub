import { describe, expect, it } from "vitest"

import {
  toAgentEventStreamResponse,
  toAgentFetchResponse,
  toAgentHttpResult,
  toAgentUiMessageStreamResponse,
  toJsonSafeAgentResult,
} from "../src/http-response.ts"

describe("agent HTTP response helpers", () => {
  it("keeps only JSON-safe Agent run result fields", () => {
    expect(toJsonSafeAgentResult({
      extra: "private",
      raw: { answer: 42 },
      text: "ok",
      usage: { inputTokens: 1 },
    })).toEqual({
      finishReason: undefined,
      raw: { answer: 42 },
      text: "ok",
      usage: { inputTokens: 1 },
      usageRecord: undefined,
      warnings: undefined,
    })
  })

  it("keeps JSON-safe Workflow Run fields", () => {
    expect(toJsonSafeAgentResult({
      id: "github:delivery",
      metadata: { workflow: "support-agent" },
      payload: { prompt: "private input" },
      provider: "vercel",
      result: "accepted",
      status: "queued",
    })).toEqual({
      id: "github:delivery",
      metadata: { workflow: "support-agent" },
      provider: "vercel",
      result: "accepted",
      status: "queued",
    })
  })

  it("returns host-native Response objects unchanged", () => {
    const response = Response.json({ ok: true })

    expect(toAgentHttpResult(response, true)).toBe(response)
    expect(toAgentFetchResponse(response, true)).toBe(response)
  })

  it("uses AI SDK stream response helpers when streaming Agent results provide them", async () => {
    const response = new Response("hello")
    const result = {
      toTextStreamResponse: () => response,
    }

    expect(toAgentHttpResult(result, true)).toBe(response)
    expect(await toAgentFetchResponse(result, true).text()).toBe("hello")
  })

  it("renders async iterable events as newline-delimited JSON", async () => {
    async function* events() {
      yield { type: "start" }
      yield { type: "done", text: "ok" }
    }

    const response = toAgentEventStreamResponse(events())

    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8")
    await expect(response.text()).resolves.toBe("{\"type\":\"start\"}\n{\"type\":\"done\",\"text\":\"ok\"}\n")
  })

  it("renders UI message streams without loading the AI SDK", async () => {
    const response = toAgentUiMessageStreamResponse({
      headers: { "x-custom": "value" },
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "start" })
          controller.close()
        },
      }),
    })

    expect(response.headers.get("x-custom")).toBe("value")
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1")
    await expect(response.text()).resolves.toBe("data: {\"type\":\"start\"}\n\ndata: [DONE]\n\n")
  })

  it("wraps non-streaming results in fetch JSON responses", async () => {
    const response = toAgentFetchResponse({ extra: "private", text: "ok" }, false)

    await expect(response.json()).resolves.toEqual({ text: "ok" })
  })
})
