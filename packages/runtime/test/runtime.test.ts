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
      attributes: { input: { prompt: "secret" }, nested: { request: { body: "secret" }, safe: true }, "step.id": "search-1", "tool.input": { query: "secret" }, "tool.name": "search" },
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
        attributes: { "content.omitted": ["input", "tool.input"], nested: { "content.omitted": ["request"], safe: true }, "step.id": "search-1", "tool.name": "search" },
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

    expect(traceEventsToOpenTelemetrySpans(log.entries())).toEqual([
      expect.objectContaining({
        endTime: "2026-01-01T00:00:00.020Z",
        name: "vitehub.run",
        spanId: "run-1",
        status: { code: "OK" },
        traceId: "run-1",
      }),
      expect.objectContaining({
        name: "agent.model.call",
        parentSpanId: "run-1",
        spanId: "model-1",
        status: { code: "OK" },
        traceId: "run-1",
      }),
    ])
  })
})
