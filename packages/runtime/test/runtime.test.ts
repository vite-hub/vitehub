import { describe, expect, it, vi } from "vitest"

import {
  ApprovalRequiredError,
  CapabilityDeniedError,
  createExecutionContext,
  createTraceEventLog,
  deriveTraceRuns,
  defineCapability,
  emitTraceEvent,
  getCapability,
  hasCapability,
  resolveCapabilityPolicy,
  resolveRuntimeValue,
  traceEventsToOpenTelemetrySpans,
  type ApprovalDecision,
  type ApprovalRequest,
  type LeaseStore,
  type RunLifecycleHooks,
} from "../src/index.ts"

describe("@vite-hub/runtime", () => {
  it("registers, finds, and resolves capability handles", () => {
    const db = defineCapability("db", { query: vi.fn() }, { name: "primary" })
    const context = createExecutionContext({
      capabilities: { db },
      memo: vi.fn(),
      runtime: "vite",
      waitUntil: vi.fn(),
    })

    expect(hasCapability(context, "db")).toBe(true)
    expect(getCapability(context, "db")).toBe(db)
    expect(() => getCapability(context, "kv")).toThrow('Capability "kv" was not found')
  })

  it("wraps raw capability values as handles", () => {
    const context = createExecutionContext({
      capabilities: { queue: { send: vi.fn() } },
      memo: vi.fn(),
      runtime: "vite",
      waitUntil: vi.fn(),
    })

    expect(getCapability(context, "queue")).toMatchObject({
      kind: "queue",
      name: "queue",
      value: { send: expect.any(Function) },
    })
  })

  it("resolves static, function, and object values against an execution context", async () => {
    const context = createExecutionContext({
      memo: vi.fn(),
      runtime: "vite",
      runtimeConfig: { region: "local" },
      waitUntil: vi.fn(),
    })

    await expect(resolveRuntimeValue("static", context)).resolves.toBe("static")
    await expect(resolveRuntimeValue(ctx => ctx.runtimeConfig.region, context)).resolves.toBe("local")
    await expect(resolveRuntimeValue({ resolve: ctx => ctx.runtime }, context)).resolves.toBe("vite")
  })

  it("models approval requests and decisions", () => {
    const request: ApprovalRequest = {
      capability: "refund",
      id: "approval-1",
      input: { amount: 100 },
      reason: "High-value refund",
      state: "awaiting-approval",
    }
    const decision: ApprovalDecision = {
      approved: true,
      requestId: request.id,
      state: "approved",
    }

    expect(new ApprovalRequiredError(request).request).toEqual(request)
    expect(decision).toMatchObject({ approved: true, state: "approved" })
  })

  it("resolves policy decisions", async () => {
    await expect(resolveCapabilityPolicy(undefined, { capability: "email" })).resolves.toBe("allow")
    await expect(resolveCapabilityPolicy("deny", { capability: "email" })).resolves.toBe("deny")
    await expect(resolveCapabilityPolicy(ctx => ctx.input ? "require-approval" : "allow", {
      capability: "refund",
      input: { amount: 100 },
    })).resolves.toBe("require-approval")
    expect(new CapabilityDeniedError("email")).toBeInstanceOf(Error)
  })

  it("models lease acquisition and release", async () => {
    const release = vi.fn()
    const store: LeaseStore = {
      acquire: async key => ({ id: "lease-1", key, release }),
    }

    const lease = await store.acquire("thread:1")
    await lease.release()

    expect(lease).toMatchObject({ id: "lease-1", key: "thread:1" })
    expect(release).toHaveBeenCalled()
  })

  it("exposes trace and lifecycle hook contracts", async () => {
    const trace = vi.fn()
    const hooks: RunLifecycleHooks = { trace }
    const context = createExecutionContext({
      memo: vi.fn(),
      runtime: "vite",
      waitUntil: vi.fn(),
    })

    await hooks.trace?.({ name: "agent.run", type: "run" }, context)

    expect(trace).toHaveBeenCalledWith({ name: "agent.run", type: "run" }, context)
  })

  it("records metadata-only trace events and derives run views", async () => {
    const log = createTraceEventLog()
    const context = createExecutionContext({
      memo: vi.fn(),
      runtime: "vite",
      trace: { id: "run-1" },
      traceLog: log,
      waitUntil: vi.fn(),
    })

    await emitTraceEvent(context, {
      attributes: { content: "secret content", input: { prompt: "secret" }, nested: { request: { body: "secret" }, safe: true }, "step.id": "search-1", "tool.input": { query: "secret" }, "tool.name": "search" },
      name: "agent.tool.start",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "run",
    })
    await emitTraceEvent(context, {
      attributes: { output: "secret result", "step.id": "search-1", "tool.name": "search" },
      name: "agent.tool.finish",
      timestamp: "2026-01-01T00:00:00.025Z",
      type: "run",
    })

    expect(log.entries()).toEqual([
      expect.objectContaining({
        attributes: { "content.omitted": ["content", "input", "tool.input"], nested: { "content.omitted": ["request"], safe: true }, "step.id": "search-1", "tool.name": "search" },
        name: "agent.tool.start",
        sequence: 1,
        trace: { id: "run-1" },
      }),
      expect.objectContaining({
        attributes: { "content.omitted": ["output"], "step.id": "search-1", "tool.name": "search" },
        name: "agent.tool.finish",
        sequence: 2,
      }),
    ])
    expect(JSON.stringify(log.entries())).not.toContain("secret")
    expect(deriveTraceRuns(log.entries())).toEqual([
      expect.objectContaining({
        durationMs: undefined,
        endTime: undefined,
        id: "run-1",
        status: "running",
        steps: [
          expect.objectContaining({
            durationMs: 25,
            name: "agent.tool",
            status: "completed",
          }),
        ],
      }),
    ])

    await emitTraceEvent(context, {
      name: "agent.invocation.finish",
      timestamp: "2026-01-01T00:00:00.030Z",
      type: "run",
    })
    expect(deriveTraceRuns(log.entries())).toEqual([
      expect.objectContaining({
        durationMs: 30,
        endTime: "2026-01-01T00:00:00.030Z",
        id: "run-1",
        status: "completed",
        steps: [
          expect.objectContaining({
            durationMs: 25,
            name: "agent.tool",
            status: "completed",
          }),
        ],
      }),
    ])
  })

  it("derives yielded stream errors as failed runs even when finish follows", async () => {
    const log = createTraceEventLog()
    await log.append({
      name: "agent.invocation.start",
      timestamp: "2026-01-01T00:00:00.000Z",
      trace: { id: "run-1" },
      type: "run",
    })
    await log.append({
      attributes: { "error.message": "stream failed" },
      name: "agent.stream.error",
      timestamp: "2026-01-01T00:00:00.010Z",
      trace: { id: "run-1" },
      type: "error",
    })
    await log.append({
      name: "agent.invocation.finish",
      timestamp: "2026-01-01T00:00:00.020Z",
      trace: { id: "run-1" },
      type: "run",
    })

    expect(deriveTraceRuns(log.entries())).toEqual([
      expect.objectContaining({
        durationMs: 20,
        endTime: "2026-01-01T00:00:00.020Z",
        id: "run-1",
        status: "failed",
      }),
    ])
    expect(traceEventsToOpenTelemetrySpans(log.entries())[0]).toMatchObject({
      status: { code: "ERROR" },
    })
  })

  it("prefers Agent Invocation run ids over shared trace ids", async () => {
    const log = createTraceEventLog()
    await log.append({
      attributes: { "agent.run.id": "agent-run-1" },
      name: "agent.invocation.start",
      timestamp: "2026-01-01T00:00:00.000Z",
      trace: { id: "request-trace" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-1" },
      name: "agent.invocation.finish",
      timestamp: "2026-01-01T00:00:00.010Z",
      trace: { id: "request-trace" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-2" },
      name: "agent.invocation.start",
      timestamp: "2026-01-01T00:00:00.020Z",
      trace: { id: "request-trace" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-2" },
      name: "agent.invocation.finish",
      timestamp: "2026-01-01T00:00:00.030Z",
      trace: { id: "request-trace" },
      type: "run",
    })

    const runs = deriveTraceRuns(log.entries()).map(run => ({ durationMs: run.durationMs, id: run.id, status: run.status }))
    expect(runs).toEqual([
      { durationMs: 10, id: "agent-run-1", status: "completed" },
      { durationMs: 10, id: "agent-run-2", status: "completed" },
    ])
  })

  it("exports valid OpenTelemetry ids while preserving ViteHub trace attributes", async () => {
    const log = createTraceEventLog({ content: "content" })
    await log.append({
      attributes: { "agent.run.id": "agent-run-1" },
      name: "agent.invocation.start",
      timestamp: "2026-01-01T00:00:00.000Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-1", "model.call.id": "model-1" },
      name: "agent.model.call.start",
      timestamp: "2026-01-01T00:00:00.010Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-1", "model.call.id": "model-1" },
      name: "agent.model.call.finish",
      timestamp: "2026-01-01T00:00:00.020Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-1" },
      name: "agent.invocation.finish",
      timestamp: "2026-01-01T00:00:00.030Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-2" },
      name: "agent.invocation.start",
      timestamp: "2026-01-01T00:00:00.040Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-2", "model.call.id": "model-1" },
      name: "agent.model.call.start",
      timestamp: "2026-01-01T00:00:00.050Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-2", "model.call.id": "model-1" },
      name: "agent.model.call.finish",
      timestamp: "2026-01-01T00:00:00.060Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })
    await log.append({
      attributes: { "agent.run.id": "agent-run-2" },
      name: "agent.invocation.finish",
      timestamp: "2026-01-01T00:00:00.070Z",
      trace: { id: "request-trace", parentId: "request-parent" },
      type: "run",
    })

    const spans = traceEventsToOpenTelemetrySpans(log.entries())
    for (const span of spans) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/)
      if (span.parentSpanId) expect(span.parentSpanId).toMatch(/^[0-9a-f]{16}$/)
    }
    expect(new Set(spans.map(span => span.traceId)).size).toBe(1)
    const run1 = spans.find(span => span.name === "vitehub.run" && span.attributes?.["vitehub.run.id"] === "agent-run-1")!
    const run2 = spans.find(span => span.name === "vitehub.run" && span.attributes?.["vitehub.run.id"] === "agent-run-2")!
    const run1Step = spans.find(span => span.name === "agent.model.call" && span.attributes?.["vitehub.run.id"] === "agent-run-1")!
    const run2Step = spans.find(span => span.name === "agent.model.call" && span.attributes?.["vitehub.run.id"] === "agent-run-2")!
    expect(run1.attributes).toMatchObject({
      "vitehub.run.id": "agent-run-1",
      "vitehub.trace.id": "request-trace",
      "vitehub.trace.parentId": "request-parent",
    })
    expect(run2.attributes).toMatchObject({
      "vitehub.run.id": "agent-run-2",
      "vitehub.trace.id": "request-trace",
      "vitehub.trace.parentId": "request-parent",
    })
    expect(run1Step).toMatchObject({
      attributes: { "model.call.id": "model-1", "vitehub.step.id": "model-1" },
      parentSpanId: run1.spanId,
    })
    expect(run2Step).toMatchObject({
      attributes: { "model.call.id": "model-1", "vitehub.step.id": "model-1" },
      parentSpanId: run2.spanId,
    })
  })

  it("maps derived trace runs to span-shaped OpenTelemetry exports", async () => {
    const log = createTraceEventLog({ content: "content" })
    await log.append({
      attributes: { "step.id": "model-1" },
      name: "agent.model.call.start",
      timestamp: "2026-01-01T00:00:00.000Z",
      trace: { id: "run-1" },
      type: "run",
    })
    await log.append({
      attributes: { "step.id": "model-1" },
      name: "agent.model.call.finish",
      timestamp: "2026-01-01T00:00:00.010Z",
      trace: { id: "run-1" },
      type: "run",
    })
    await log.append({
      name: "agent.invocation.finish",
      timestamp: "2026-01-01T00:00:00.020Z",
      trace: { id: "run-1" },
      type: "run",
    })

    const spans = traceEventsToOpenTelemetrySpans(log.entries())
    expect(spans).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          "vitehub.run.id": "run-1",
          "vitehub.trace.id": "run-1",
        }),
        endTime: "2026-01-01T00:00:00.020Z",
        name: "vitehub.run",
        spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
        status: { code: "OK" },
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          "step.id": "model-1",
          "vitehub.run.id": "run-1",
          "vitehub.step.id": "model-1",
        }),
        name: "agent.model.call",
        parentSpanId: expect.stringMatching(/^[0-9a-f]{16}$/),
        spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
        status: { code: "OK" },
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
    ])
    expect(spans[1]!.parentSpanId).toBe(spans[0]!.spanId)
    expect(spans[1]!.traceId).toBe(spans[0]!.traceId)
  })
})
