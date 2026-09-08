import { describe, expect, it, vi } from "vitest"

import { createTraceEventLog } from "@vite-hub/runtime"

import { createAgentInvocationContextStore } from "../src/invocation-context.ts"
import type { StreamEvent } from "../src/messages.ts"
import { type AgentTraceContext, createAgentStreamEventTracer, createToolDurationTracker, traceAgentStreamEvents } from "../src/trace.ts"

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

describe("tool timing with telemetry backpressure", () => {
  it.each(["buffered", "iterable"] as const)("excludes slow sinks and buffered flushes in the %s path", async (path) => {
    let now = 1_000
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    const traceLog = createTraceEventLog({
      content: "content",
      async onEntry() {
        await Promise.resolve()
        now += 5_000
      },
    })
    // SAFETY: Stream tracing only reads the context store and runtime trace fields.
    const context = { context: createAgentInvocationContextStore(), runtime: { traceLog } } as AgentTraceContext
    const result: StreamEvent = { durationMs: 0, id: "tool-1", name: "shell", type: "tool-result" }
    async function* events(): AsyncIterable<StreamEvent> {
      yield { id: "text-1", text: "before", type: "text-delta" }
      yield { id: "tool-1", name: "shell", type: "tool-call" }
      now += 250
      yield { data: { kind: "content.delta", value: { delta: "output", streamKind: "command_output" } }, id: "tool-1", type: "data-agent-event" }
      now += 500
      yield result
    }
    try {
      if (path === "buffered") {
        const tracer = createAgentStreamEventTracer(context)
        for await (const event of events()) await tracer.write(event)
        await tracer.flush()
      }
      else {
        const yielded = []
        for await (const event of traceAgentStreamEvents(events(), context)) yielded.push(event)
        expect(yielded.at(-1)).toBe(result)
      }
      expect(traceLog.entries().find(event => event.name === "agent.tool.finish"))
        .toMatchObject({ attributes: { "tool.durationMs": 750 } })
      expect(result.durationMs).toBe(0)
    }
    finally {
      clock.mockRestore()
    }
  })
})
