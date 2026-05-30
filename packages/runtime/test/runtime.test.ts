import { describe, expect, it, vi } from "vitest"

import {
  ApprovalRequiredError,
  CapabilityDeniedError,
  createExecutionContext,
  defineCapability,
  getCapability,
  hasCapability,
  resolveCapabilityPolicy,
  resolveRuntimeValue,
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
      runtime: "nitro",
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
      runtime: "nitro",
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
      runtime: "nitro",
      runtimeConfig: { region: "local" },
      waitUntil: vi.fn(),
    })

    await expect(resolveRuntimeValue("static", context)).resolves.toBe("static")
    await expect(resolveRuntimeValue(ctx => ctx.runtimeConfig.region, context)).resolves.toBe("local")
    await expect(resolveRuntimeValue({ resolve: ctx => ctx.runtime }, context)).resolves.toBe("nitro")
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
      runtime: "nitro",
      waitUntil: vi.fn(),
    })

    await hooks.trace?.({ name: "agent.run", type: "run" }, context)

    expect(trace).toHaveBeenCalledWith({ name: "agent.run", type: "run" }, context)
  })
})
