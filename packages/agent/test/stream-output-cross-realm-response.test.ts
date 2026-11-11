import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"

import { describe, expect, it, vi } from "vitest"

import { defineAgent, runAgent, streamAgent } from "../src/index.ts"
import { adapterDefinition } from "./adapter-definition.ts"
import { streamAgentInline } from "../src/internal/agent-run.ts"
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
  // Node.js 22 bundles an undici that reads `global`.
  return runInNewContext(`var global = globalThis
    ${source}
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
  it.each(["run", "adapter"])("drains a foreign Response at the public run boundary: %s", async (driver) => {
    const response = foreignResponse("foreign output")
    response.headers.delete("x-vercel-ai-ui-message-stream")
    const agent = driver === "run"
      ? defineAgent({ driver: { run: () => response }, runtime: false })
      : adapterDefinition({ generate: () => response })
    const [error, result] = await runAgent(agent, {})
    expect(error).toBeUndefined()
    expect(result?.text).toBe("foreign output")
    expect(response.bodyUsed).toBe(true)
  })

  it("accepts a foreign UI Response at the public stream boundary", async () => {
    const response = foreignResponse()
    const agent = defineAgent({ driver: { run: () => response }, runtime: false })
    const [error, stream] = await streamAgent(agent, {}, { output: "ui-message-stream" })
    expect(error).toBeUndefined()
    expect(await stream?.text()).toContain('"text":"foreign"')
  })

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
    expect(normalized).toBe(response)
    if (!normalized) throw new Error("Expected normalized UI stream response")
    const chunks: unknown[] = []
    for await (const chunk of uiMessageStreamFromResponse(normalized)) chunks.push(chunk)
    expect(chunks).toEqual([{ text: "foreign", type: "text" }])
  })

  it("routes a foreign UI stream Response through Agent finalization", async () => {
    const agent = defineAgent({ driver: { run: () => foreignResponse() } })
    const response = await streamAgentInline(agent, {
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

  it("forwards cancellation to an independent Undici Response body", async () => {
    const cancelled = vi.fn()
    const source = new ReadableStream<Uint8Array>({ cancel: cancelled })
    const agent = defineAgent({ driver: { run: () => foreignResponse(source) } })
    const response = await streamAgentInline(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {}, { output: "ui-message-stream" })
    if (!(response instanceof Response) || !response.body) throw new Error("Expected finalized response")
    await response.body.cancel("consumer cancelled")
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())
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
