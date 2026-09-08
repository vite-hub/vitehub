import { describe, expect, it } from "vitest"

import { createToolDurationTracker } from "../src/trace.ts"

describe("Agent stream trace", () => {
  it("measures a tool result from its observed start when the provider reports zero", () => {
    let now = 1_000
    const track = createToolDurationTracker(() => now)
    track({ id: "tool-1", name: "shell", type: "tool-call" })
    now = 1_750

    expect(track({ durationMs: 0, id: "tool-1", name: "shell", type: "tool-result" }))
      .toMatchObject({ durationMs: 750 })
  })

  it("keeps an unobserved zero tool duration unknown", () => {
    const track = createToolDurationTracker(() => 1_000)

    expect(track({ durationMs: 0, id: "tool-1", name: "shell", type: "tool-result" }))
      .not.toHaveProperty("durationMs", 0)
  })

  it("preserves a positive provider tool duration", () => {
    const track = createToolDurationTracker(() => 1_000)
    track({ id: "tool-1", name: "shell", type: "tool-input-start" })

    expect(track({ durationMs: 42, id: "tool-1", name: "shell", type: "tool-result" }))
      .toMatchObject({ durationMs: 42 })
  })

  it("does not count tool input streaming as execution time", () => {
    let now = 1_000
    const track = createToolDurationTracker(() => now)
    track({ id: "tool-1", name: "shell", type: "tool-input-start" })
    now = 1_750

    expect(track({ durationMs: 0, id: "tool-1", name: "shell", type: "tool-result" }))
      .not.toHaveProperty("durationMs")
  })
})
