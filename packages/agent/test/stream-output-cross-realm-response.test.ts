import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"

import { describe, expect, it, vi } from "vitest"

import { streamAgent, defineAgent } from "../src/index.ts"
import { isUIMessageStreamResponse, normalizeUIMessageStreamResponse, uiMessageStreamFromResponse } from "../src/stream-output.ts"

function foreignResponse(payload: string | ReadableStream<Uint8Array> = 'data: {"type":"text","text":"foreign"}\n\ndata: [DONE]\n\n'): Response {
  // Node VM contexts do not install fetch globals. Evaluate Node's bundled
  // fetch implementation there so its Response class and private slots belong
  // to that realm; injecting the host Response constructor would not test this.
  const source = runInNewContext('process.binding("natives")["internal/deps/undici/undici"]', { process })
  const module = { exports: {} }
  const globals = Object.fromEntries([
    "Buffer", "URL", "URLSearchParams", "TextEncoder", "TextDecoder",
    "ReadableStream", "TransformStream", "WritableStream", "AbortController",
    "AbortSignal", "MessagePort", "structuredClone", "performance",
    "setTimeout", "clearTimeout", "setImmediate", "clearImmediate",
    "queueMicrotask", "console", "Blob", "File", "DOMException",
    "Event", "EventTarget", "MessageEvent", "CustomEvent",
  ].map(name => [name, Reflect.get(globalThis, name)]))
  return runInNewContext(`${source}
    new module.exports.Response(payload, {
      headers: { "x-vercel-ai-ui-message-stream": "v1" },
    })`, {
    ...globals,
    module,
    payload,
    process,
    require: createRequire(import.meta.url),
  })
}

describe("Agent UI stream response boundaries", () => {
  it("preserves an unshadowed local UI Response identity", () => {
    const response = new Response("data: [DONE]\n\n", { headers: { "x-vercel-ai-ui-message-stream": "v1" } })
    expect(isUIMessageStreamResponse(response)).toBe(true)
    expect(normalizeUIMessageStreamResponse(response)).toBe(response)
  })

  it("preserves a locked local UI Response without consuming it", () => {
    const response = new Response("data: [DONE]\n\n", { headers: { "x-vercel-ai-ui-message-stream": "v1" } })
    const reader = response.body!.getReader()
    expect(normalizeUIMessageStreamResponse(response)).toBe(response)
    expect(response.bodyUsed).toBe(false)
    reader.releaseLock()
  })

  it("preserves a consumed local UI Response identity", async () => {
    const response = new Response("data: [DONE]\n\n", { headers: { "x-vercel-ai-ui-message-stream": "v1" } })
    await response.text()
    expect(normalizeUIMessageStreamResponse(response)).toBe(response)
    expect(response.bodyUsed).toBe(true)
  })

  it("does not pull a bridged foreign body before consumption and releases cancellation", async () => {
    const pull = vi.fn()
    const cancel = vi.fn()
    const source = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
    const normalized = normalizeUIMessageStreamResponse(foreignResponse(source))
    if (!normalized) throw new Error("Expected normalized response")
    await Promise.resolve()
    await Promise.resolve()
    expect(pull).not.toHaveBeenCalled()
    await normalized.body.cancel("stopped")
    expect(cancel).toHaveBeenCalledWith("stopped")
    expect(source.locked).toBe(false)
  })

  it("releases the source reader after a foreign body error", async () => {
    const failure = new Error("source failure")
    const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure) } }, { highWaterMark: 0 })
    const normalized = normalizeUIMessageStreamResponse(foreignResponse(source))
    if (!normalized) throw new Error("Expected normalized response")
    await expect(normalized.text()).rejects.toBe(failure)
    expect(source.locked).toBe(false)
  })

  it("recognizes and parses a genuine foreign-realm Response", async () => {
    const response = foreignResponse()
    expect(response).not.toBeInstanceOf(Response)
    expect(response.constructor).not.toBe(Response)
    expect(Object.prototype.toString.call(response)).toBe("[object Response]")
    // A local native body accessor rejects the foreign stream; the predicate
    // must select and apply the foreign stream and Headers accessors instead.
    const localBody = Object.getOwnPropertyDescriptor(Response.prototype, "body")!.get!
    expect(() => localBody.call(response)).toThrow()
    expect(isUIMessageStreamResponse(response)).toBe(true)
    const normalized = normalizeUIMessageStreamResponse(response)
    expect(normalized).toBeInstanceOf(Response)
    if (!normalized) throw new Error("Expected normalized UI stream response")
    const chunks: unknown[] = []
    for await (const chunk of uiMessageStreamFromResponse(normalized)) chunks.push(chunk)
    expect(chunks).toEqual([{ text: "foreign", type: "text" }])
  })

  it("routes a foreign UI stream Response through Agent finalization", async () => {
    const agent = defineAgent({ driver: { run: () => foreignResponse() } })
    const response = await streamAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {}, { output: "ui-message-stream" })
    expect(response).toBeInstanceOf(Response)
    if (!(response instanceof Response)) throw new Error("Expected finalized response")
    const chunks: unknown[] = []
    for await (const chunk of uiMessageStreamFromResponse(response as Response & { body: ReadableStream<Uint8Array> })) chunks.push(chunk)
    expect(chunks).toEqual([{ text: "foreign", type: "text" }])
  })

  it("rejects a complete structural response with a spoofed tag", () => {
    const response = {
      body: new ReadableStream(),
      headers: new Headers({ "x-vercel-ai-ui-message-stream": "v1" }),
      [Symbol.toStringTag]: "Response",
    }
    expect(isUIMessageStreamResponse(response)).toBe(false)
    expect(normalizeUIMessageStreamResponse(response)).toBeUndefined()
  })

  it("does not invoke a plain carrier's stream methods", () => {
    const pipeThrough = vi.fn(() => { throw new Error("untrusted method") })
    const value = { [Symbol.toStringTag]: "Response", body: { pipeThrough }, headers: { get: () => "v1" } }
    expect(isUIMessageStreamResponse(value)).toBe(false)
    expect(normalizeUIMessageStreamResponse(value)).toBeUndefined()
    expect(pipeThrough).not.toHaveBeenCalled()
  })

  it("captures foreign response fields once before Agent finalization", async () => {
    const response = foreignResponse()
    const originalBody = response.body
    const originalHeaders = response.headers
    let bodyReads = 0
    let headersReads = 0
    Object.defineProperties(response, {
      body: { get() { if (++bodyReads > 1) throw new Error("body reread"); return originalBody } },
      headers: { get() { if (++headersReads > 1) throw new Error("headers reread"); return originalHeaders } },
    })
    const agent = defineAgent({ driver: { run: () => response } })
    const finalized = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {}, { output: "ui-message-stream" })
    if (!(finalized instanceof Response)) throw new Error("Expected finalized response")
    const chunks: unknown[] = []
    for await (const chunk of uiMessageStreamFromResponse(finalized as Response & { body: ReadableStream<Uint8Array> })) chunks.push(chunk)
    expect(chunks).toEqual([{ text: "foreign", type: "text" }])
    expect(bodyReads).toBe(1)
    expect(headersReads).toBe(1)
  })

  it("parses foreign bytes without invoking an overridden pipeThrough", async () => {
    const response = foreignResponse()
    const pipeThrough = vi.fn(() => { throw new Error("overridden pipeThrough") })
    Object.defineProperty(response.body, "pipeThrough", { value: pipeThrough })
    const chunks: unknown[] = []
    for await (const chunk of uiMessageStreamFromResponse(response as Response & { body: ReadableStream<Uint8Array> })) chunks.push(chunk)
    expect(chunks).toEqual([{ text: "foreign", type: "text" }])
    expect(pipeThrough).not.toHaveBeenCalled()
  })

  it("forwards cancellation to an independent Undici Response body", async () => {
    const cancelled = vi.fn()
    const source = new ReadableStream<Uint8Array>({ cancel: cancelled })
    const agent = defineAgent({ driver: { run: () => foreignResponse(source) } })
    const response = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {}, { output: "ui-message-stream" })
    if (!(response instanceof Response) || !response.body) throw new Error("Expected finalized response")
    await response.body.cancel("consumer cancelled")
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())
  })

  it("rejects an overridden reader before normalization invokes it", () => {
    const response = foreignResponse()
    const getReader = vi.fn(() => { throw new Error("overridden reader") })
    Object.defineProperty(response.body, "getReader", { value: getReader })
    expect(normalizeUIMessageStreamResponse(response)).toBeUndefined()
    expect(getReader).not.toHaveBeenCalled()
  })

  it("rejects a Response prototype proxy without native state", () => {
    const value = new Proxy(Object.create(Response.prototype), {})
    expect(isUIMessageStreamResponse(value)).toBe(false)
    expect(normalizeUIMessageStreamResponse(value)).toBeUndefined()
  })

  it("rejects a Response prototype carrier with supplied fields", () => {
    const value = Object.create(Response.prototype, {
      status: { get: () => 200 },
      statusText: { get: () => "OK" },
      headers: { get: () => new Headers({ "x-vercel-ai-ui-message-stream": "v1" }) },
      body: { get: () => new ReadableStream() },
      type: { get: () => "default" },
    })
    expect(isUIMessageStreamResponse(value)).toBe(false)
    expect(normalizeUIMessageStreamResponse(value)).toBeUndefined()
  })

  it("rejects a carrier inheriting from a foreign Response prototype", () => {
    const response = foreignResponse()
    const value = Object.create(Object.getPrototypeOf(response), {
      status: { get: () => 200 },
      statusText: { get: () => "OK" },
      headers: { get: () => new Headers({ "x-vercel-ai-ui-message-stream": "v1" }) },
      body: { get: () => new ReadableStream() },
      type: { get: () => "default" },
    })
    expect(isUIMessageStreamResponse(value)).toBe(false)
    expect(normalizeUIMessageStreamResponse(value)).toBeUndefined()
  })

  it.each([
    null,
    {},
    new Response(null, { headers: { "x-vercel-ai-ui-message-stream": "v1" } }),
    new Response("ordinary response"),
    { [Symbol.toStringTag]: "Response", body: {}, headers: { get: () => "v1" } },
    { [Symbol.toStringTag]: "Response", body: new ReadableStream(), headers: {} },
    { [Symbol.toStringTag]: "Response", body: new ReadableStream(), headers: { get: () => "v2" } },
    { get [Symbol.toStringTag]() { throw new Error("hostile tag") } },
    { [Symbol.toStringTag]: "Response", get body() { throw new Error("hostile body") } },
    { [Symbol.toStringTag]: "Response", body: new ReadableStream(), headers: { get() { throw new Error("hostile headers") } } },
  ])("rejects malformed or unmarked input %# without throwing", (value) => {
    expect(isUIMessageStreamResponse(value)).toBe(false)
  })
})
