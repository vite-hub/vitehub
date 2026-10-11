import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { isUIMessageStreamResponse, uiMessageStreamFromResponse } from "../src/stream-output.ts"

describe("Agent UI stream response boundaries", () => {
  it("recognizes a UI message Response created in another realm", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {\"type\":\"text\",\"text\":\"foreign\"}\n\n"))
        controller.close()
      },
    })
    const response = runInNewContext(`(() => {
      const value = { body, headers: { get: name => name === "x-vercel-ai-ui-message-stream" ? "v1" : null } }
      Object.defineProperty(value, Symbol.toStringTag, { value: "Response" })
      return value
    })()`, { body }) as Response

    expect(isUIMessageStreamResponse(response)).toBe(true)
    const chunks: unknown[] = []
    for await (const chunk of uiMessageStreamFromResponse(response)) chunks.push(chunk)
    expect(chunks).toEqual([{ text: "foreign", type: "text" }])
  })
})
