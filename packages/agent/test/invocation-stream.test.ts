import { describe, expect, it } from "vitest"

import { createAgentInvocationStreamResponse, readAgentInvocationStream } from "../src/invocation-stream.ts"

describe("Agent Invocation Stream", () => {
  it("closes timed-out streams even when the run does not settle", async () => {
    let aborted = false
    const response = createAgentInvocationStreamResponse(async (_emit, signal) => {
      signal.addEventListener("abort", () => {
        aborted = true
      })
      await new Promise(() => {})
    }, { timeout: 10 })

    const text = await Promise.race([
      response.text(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("stream stayed open")), 100)),
    ])

    expect(text.trim().split("\n").map(line => JSON.parse(line))).toEqual([
      { error: "Agent Invocation Stream timed out after 10ms.", type: "error" },
      { type: "done" },
    ])
    expect(aborted).toBe(true)
  })

  it("closes with an error when event serialization fails", async () => {
    const response = createAgentInvocationStreamResponse(async (emit) => {
      emit({ data: 1n, type: "data" } as never)
    })

    const events = []
    for await (const event of readAgentInvocationStream(response.body!)) {
      events.push(event)
    }

    expect(events).toEqual([
      { error: "Do not know how to serialize a BigInt", type: "error" },
      { type: "done" },
    ])
  })
})
