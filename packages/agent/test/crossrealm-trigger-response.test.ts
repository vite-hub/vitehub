import { Response as ForeignFetchResponse } from "@whatwg-node/node-fetch"
import { afterEach, describe, expect, it, vi } from "vitest"
import { streamAgentOutputToEvents } from "../src/agent-output.ts"
import { isResponse } from "../src/internal/response.ts"
import { isUIMessageStreamResponse, normalizeUIMessageStreamResponse, uiMessageStreamFromResponse } from "../src/stream-output.ts"
import { isResolvedAgentTriggerHandledInvocation, resolveAgentTriggerInvocationResult } from "../src/trigger-runtime.ts"

const HostResponse = Response

function foreignResponse(body = "foreign", init?: ConstructorParameters<typeof ForeignFetchResponse>[1]): Response {
  const response = new ForeignFetchResponse(body, init)
  vi.stubGlobal("Response", class extends HostResponse {})
  expect(response).not.toBeInstanceOf(Response)
  return response as unknown as Response
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

  it("accepts subclasses of a foreign Response implementation", () => {
    class SubResponse extends ForeignFetchResponse {}
    const response = new SubResponse("subclass")
    expect(isResponse(response)).toBe(true)
  })
})
