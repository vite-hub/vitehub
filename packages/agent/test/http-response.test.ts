import vm from "node:vm"
import { describe, expect, it, vi } from "vitest"

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

  it("preserves Response objects created in another realm", () => {
    const response = vm.runInNewContext("new Response('ok', { status: 200 })", { Response })

    expect(toAgentHttpResult(response, false)).toBe(response)
    expect(toAgentFetchResponse(response, false)).toBe(response)
  })

  it("preserves branded Responses with a custom observable tag", () => {
    const response = vm.runInNewContext("new Response('ok')", { Response })
    Object.defineProperty(response, Symbol.toStringTag, { value: "Object" })
    // Node's VM has no separate fetch globals. Simulate the constructor identity
    // mismatch while retaining the native accessors and the response's slots.
    vi.stubGlobal("Response", new Proxy(Response, {
      get(target, key, receiver) {
        if (key === Symbol.hasInstance) return () => false
        return Reflect.get(target, key, receiver)
      },
    }))
    try {
      expect(response instanceof Response).toBe(false)
      expect(toAgentHttpResult(response, false)).toBe(response)
      expect(toAgentFetchResponse(response, false)).toBe(response)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it("does not treat a complete Response spoof as a Response", () => {
    const result = {
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      blob: () => Promise.resolve(new Blob([])),
      body: null,
      bodyUsed: false,
      clone: () => result,
      formData: () => Promise.resolve(new FormData()),
      headers: { get: () => null },
      json: () => Promise.resolve({}),
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(""),
    }
    Object.defineProperty(result, Symbol.toStringTag, { value: "Response" })

    const converted = toAgentHttpResult(result, false)
    expect(converted).not.toBe(result)
    expect(converted).toMatchObject({ finishReason: undefined, raw: undefined, usage: undefined })
  })

  it("falls back when a result has an unreadable response tag", () => {
    const result = { text: "ok" }
    Object.defineProperty(result, Symbol.toStringTag, {
      get() {
        throw new Error("unreadable")
      },
    })

    expect(toAgentHttpResult(result, false)).toEqual({
      finishReason: undefined,
      raw: undefined,
      text: "ok",
      usage: undefined,
      usageRecord: undefined,
      warnings: undefined,
    })
  })

  it("falls back when a result throws during Response brand inspection", () => {
    const result = new Proxy({ text: "ok" }, {
      getPrototypeOf() {
        throw new Error("unreadable prototype")
      },
    })

    expect(toAgentHttpResult(result, false)).toEqual({
      finishReason: undefined,
      raw: undefined,
      text: "ok",
      usage: undefined,
      usageRecord: undefined,
      warnings: undefined,
    })
  })

  it("does not treat a minimal Response-shaped result as a Response", () => {
    const result = {
      headers: { get: () => null },
      status: 200,
      statusText: "OK",
    }
    Object.defineProperty(result, Symbol.toStringTag, { value: "Response" })

    expect(toAgentHttpResult(result, false)).toEqual({
      finishReason: undefined,
      raw: undefined,
      text: undefined,
      usage: undefined,
      usageRecord: undefined,
      warnings: undefined,
    })
  })

  it("uses AI SDK stream response helpers when streaming Agent results provide them", async () => {
    const response = new Response("hello")
    const result = {
      toTextStreamResponse: () => response,
    }

    expect(toAgentHttpResult(result, true)).toBe(response)
    expect(await toAgentFetchResponse(result, true).text()).toBe("hello")
  })

  it("falls back when an optional UI stream helper is not callable", async () => {
    const response = new Response("hello")
    const result = {
      toUIMessageStreamResponse: true,
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
