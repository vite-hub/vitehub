import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { isUIMessageStreamResponse, uiMessageStreamFromResponse } from "../src/stream-output.ts"

function foreignResponse(): Response {
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
    payload: 'data: {"type":"text","text":"foreign"}\n\ndata: [DONE]\n\n',
    process,
    require: createRequire(import.meta.url),
  })
}

describe("Agent UI stream response boundaries", () => {
  it("recognizes and parses a genuine foreign-realm Response", async () => {
    const response = foreignResponse()
    expect(response).not.toBeInstanceOf(Response)
    expect(response.constructor).not.toBe(Response)
    expect(Object.prototype.toString.call(response)).toBe("[object Response]")
    // A local native accessor would reintroduce the cross-realm rejection.
    const localBody = Object.getOwnPropertyDescriptor(Response.prototype, "body")!.get!
    expect(() => localBody.call(response)).toThrow()
    expect(isUIMessageStreamResponse(response)).toBe(true)
    if (!isUIMessageStreamResponse(response)) throw new Error("Expected UI stream response")
    const chunks: unknown[] = []
    for await (const chunk of uiMessageStreamFromResponse(response)) chunks.push(chunk)
    expect(chunks).toEqual([{ text: "foreign", type: "text" }])
  })

  it("accepts a complete structural response, including a spoofed tag", () => {
    // Recognition is not authentication: callers may supply compatible adapters.
    const response = {
      body: new ReadableStream(),
      headers: new Headers({ "x-vercel-ai-ui-message-stream": "v1" }),
      [Symbol.toStringTag]: "Response",
    }
    expect(isUIMessageStreamResponse(response)).toBe(true)
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
