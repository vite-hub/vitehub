import { describe, expect, it } from "vitest"

import { createAgentInvocationStreamResponse, readAgentInvocationStream } from "../src/invocation-stream.ts"

describe("Agent Invocation Stream", () => {
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
