import { runInNewContext } from "node:vm"
import { afterEach, describe, expect, it, vi } from "vitest"
import { streamAgentOutputToEvents } from "../src/agent-output.ts"
import { isResponse } from "../src/internal/response.ts"
import { isUIMessageStreamResponse, normalizeUIMessageStreamResponse, uiMessageStreamFromResponse } from "../src/stream-output.ts"
import { isResolvedAgentTriggerHandledInvocation, resolveAgentTriggerInvocationResult } from "../src/trigger-runtime.ts"

const HostResponse = Response

function foreignResponse(body = "foreign", init?: ResponseInit): Response {
  // Node VM contexts have no Fetch globals. Supply the host Fetch implementation,
  // then give the consuming realm a different constructor, as runtime loaders do.
  const response = runInNewContext("new Response(body, init)", { Response: HostResponse, body, init })
  vi.stubGlobal("Response", class extends HostResponse {})
  expect(response).not.toBeInstanceOf(Response)
  return response
}

afterEach(() => vi.unstubAllGlobals())

describe("agent trigger cross realm responses", () => {
  it("preserves a real Response created in a VM using the host Fetch implementation", async () => {
    const response = foreignResponse()
    const result = resolveAgentTriggerInvocationResult(response, {} as never)
    expect(isResolvedAgentTriggerHandledInvocation(result)).toBe(true)
    expect(result).toMatchObject({ response })
    expect(await response.text()).toBe("foreign")
  })

  it("streams a handled foreign response body", async () => {
    const response = foreignResponse()
    const result = resolveAgentTriggerInvocationResult(response, {} as never)
    if (!isResolvedAgentTriggerHandledInvocation(result)) throw new Error("Expected handled response")
    const events = []
    for await (const event of streamAgentOutputToEvents(result.response)) events.push(event)
    expect(events).toEqual([{ text: "foreign", type: "text-delta" }, { type: "finish" }])
  })

  it("recognizes and parses UI responses with an inherited global Response prototype", async () => {
    const response = foreignResponse('data: {"type":"text-delta","delta":"foreign"}\n\ndata: [DONE]\n\n', {
      headers: { "x-vercel-ai-ui-message-stream": "v1" },
    })
    expect(isUIMessageStreamResponse(response)).toBe(true)
    expect(normalizeUIMessageStreamResponse(response)).toBe(response)
    if (!isUIMessageStreamResponse(response)) throw new Error("Expected UI response")
    const chunks = []
    for await (const chunk of uiMessageStreamFromResponse(response)) chunks.push(chunk)
    expect(chunks).toEqual([{ type: "text-delta", delta: "foreign" }])
  })

  it("rejects a complete structural impostor", () => {
    const impostor = {
      input: { context: {}, value: "ordinary input" },
      headers: new Headers(), body: null, status: 200, statusText: "OK",
      ok: true, redirected: false, url: "", type: "default", bodyUsed: false,
      clone() { return this },
      arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)) },
      blob() { return Promise.resolve(new Blob([])) },
      formData() { return Promise.resolve(new FormData()) },
      json() { return Promise.resolve(null) },
      text() { return Promise.resolve("impostor") },
      [Symbol.toStringTag]: "Response",
    }
    expect(isResponse(impostor)).toBe(false)
    const result = resolveAgentTriggerInvocationResult(impostor, {} as never)
    expect(result).toMatchObject({ input: { value: "ordinary input" } })
    expect(result).not.toHaveProperty("response")
  })

  it("rejects a Symbol.toStringTag impostor", () => {
    const impostor = runInNewContext(`({ input: { context: {}, value: "input" }, [Symbol.toStringTag]: "Response" })`)
    const result = resolveAgentTriggerInvocationResult(impostor, {} as never)
    expect(result).toMatchObject({ input: { value: "input" } })
    expect(result).not.toHaveProperty("response")
  })

  it("rejects inherited Response prototypes without internal response state", () => {
    expect(isResponse(Object.create(HostResponse.prototype))).toBe(false)
  })

  it("contains hostile inspection and does not read user response properties", () => {
    const hostile = runInNewContext(`Object.defineProperty({ input: { context: {} } }, Symbol.toStringTag, {
      get() { throw new Error("hostile") }
    })`)
    expect(() => resolveAgentTriggerInvocationResult(hostile, {} as never)).not.toThrow()
    expect(isResponse(new Proxy({}, { get() { throw new Error("hostile") } }))).toBe(false)
    expect(isResponse(Object.defineProperty({}, "headers", { get() { throw new Error("hostile") } }))).toBe(false)
  })
})
