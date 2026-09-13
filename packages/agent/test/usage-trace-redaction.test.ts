import { expect, it, vi } from "vitest"
import { traceAgentInvocationFinish, traceAgentStreamEvent, type AgentTraceContext } from "../src/trace.ts"
import type { StreamEvent } from "../src/messages.ts"

const { emitTraceEvent } = vi.hoisted(() => ({ emitTraceEvent: vi.fn() }))
vi.mock("@vite-hub/runtime", () => ({ emitTraceEvent }))

it.each([
  { model: "postgres://alice:hunter2@host/model", source: "token=hunter2", expectedModel: "postgres://[REDACTED]@host/model", expectedSource: "token=[REDACTED]" },
  { model: "gpt-6-astra", source: "models.dev", expectedModel: "gpt-6-astra", expectedSource: "models.dev" },
  { model: undefined, source: undefined, expectedModel: undefined, expectedSource: undefined },
])("redacts usage metadata before the trace sink receives it: $model", async ({ model, source, expectedModel, expectedSource }) => {
  const context: AgentTraceContext = {
    context: { entries: () => new Map<string, unknown>().entries(), get: vi.fn(), has: vi.fn(), set: vi.fn(), toJSON: () => ({}) },
    // SAFETY: Usage tracing only forwards the runtime to the mocked sink.
    runtime: {} as AgentTraceContext["runtime"],
    input: {},
    invoker: { id: "usage-trace-test" },
  }
  const event: StreamEvent = {
    type: "usage",
    usageRecord: {
      model,
      ...(source ? { cost: { source, display: "~$0.01", usd: "0.01", estimated: true } } : {}),
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    },
  }
  const original = structuredClone(event)

  await traceAgentStreamEvent(context, event)

  expect(emitTraceEvent).toHaveBeenLastCalledWith(context.runtime, expect.objectContaining({
    name: "agent.usage.recorded",
    attributes: expect.objectContaining({
      "usage.model": expectedModel,
      "usage.costSource": expectedSource,
      "usage.totalTokens": 3,
    }),
  }))
  expect(JSON.stringify(emitTraceEvent.mock.lastCall)).not.toContain("hunter2")
  expect(event).toEqual(original)
})

it("redacts terminal usage metadata without changing provider evidence", async () => {
  const context: AgentTraceContext = {
    context: { entries: () => new Map<string, unknown>().entries(), get: vi.fn(), has: vi.fn(), set: vi.fn(), toJSON: () => ({}) },
    // SAFETY: Usage tracing only forwards the runtime to the mocked sink.
    runtime: {} as AgentTraceContext["runtime"],
    input: {},
    invoker: { id: "usage-trace-test" },
  }
  const raw = { providerText: "Retain original response evidence" }
  const call = {
    model: "postgres://alice:hunter2@host/model",
    provider: "token=provider-secret",
    cost: { source: "token=pricing-secret", usd: "0.01", estimated: true },
    usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    raw,
  }
  const usage = { ...call, calls: [call, { model: "gpt-6-astra", provider: "codex", cost: { source: "models.dev" } }] }
  const original = structuredClone(usage)

  await traceAgentInvocationFinish(context, { "usage.record": usage })

  const safeCall = {
    ...call,
    model: "postgres://[REDACTED]@host/model",
    provider: "token=[REDACTED]",
    cost: { ...call.cost, source: "token=[REDACTED]" },
  }
  expect(emitTraceEvent).toHaveBeenLastCalledWith(context.runtime, expect.objectContaining({
    name: "agent.invocation.finish",
    attributes: expect.objectContaining({
      "usage.record": { ...safeCall, calls: [safeCall, usage.calls[1]] },
    }),
  }))
  expect(usage).toEqual(original)
})
