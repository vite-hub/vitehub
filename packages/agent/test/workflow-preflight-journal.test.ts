import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent, portableAgentWorkflowInput, runAgent, startAgentInvocation, workflow } from "../src/index.ts"
import { setAgentWorkflowRuntimeLoaders } from "../src/internal/workflow-runtime-loaders.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"

afterEach(() => {
  setAgentWorkflowRuntimeLoaders({
    state: () => import("@vite-hub/workflow/runtime/state"),
    workflow: () => import("@vite-hub/workflow"),
  })
  vi.restoreAllMocks()
})

function runtime() {
  return { memo: vi.fn(), run: { runId: "parent-run" }, runtime: "unknown" as const, waitUntil: vi.fn() }
}

async function workflowState() {
  const state = await import("@vite-hub/workflow/runtime/state")
  return { ...state, getWorkflowRuntimeConfig: () => ({ provider: "openworkflow" as const }) }
}

describe("Workflow preparation Invocation journal", () => {
  it.each(["state", "definition", "input"] as const)("records %s preparation failures before provider dispatch", async (stage) => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const failure = new Error("Workflow preparation failed")
    const providerRun = vi.fn()
    setAgentWorkflowRuntimeLoaders({
      state: stage === "state" ? async () => { throw failure } : workflowState,
      workflow: async () => ({
        ...await import("@vite-hub/workflow"),
        createWorkflow: () => {
          if (stage === "definition") throw failure
          // SAFETY: This fixture only creates a handle; invalid input must fail before run.
          return { run: providerRun } as never
        },
      }),
    })
    const agent = defineAgent({ driver: { run: () => "unreachable" }, invocations, name: "preflight", runtime: workflow("preflight") })
    const result = runAgent(agent, runtime(), stage === "input" ? { context: { invalid: () => true } } : {})
    if (stage === "input") await expect(result).rejects.toThrow()
    else await expect(result).rejects.toBe(failure)
    expect(providerRun).not.toHaveBeenCalled()
    const record = await invocations.getByRunId("parent-run", "preflight")
    expect(record).toMatchObject({ status: "failed" })
    expect(record?.error?.message).toBeTruthy()
  })

  it("records cancellation during preparation", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const controller = new AbortController()
    const failure = new Error("Preparation cancelled")
    setAgentWorkflowRuntimeLoaders({
      state: async () => { controller.abort(failure); throw failure },
      workflow: () => import("@vite-hub/workflow"),
    })
    const agent = defineAgent({ driver: { run: () => "unreachable" }, invocations, name: "preflight", runtime: workflow("preflight") })
    await expect(runAgent(agent, runtime(), { abortSignal: controller.signal })).rejects.toBe(failure)
    await expect(invocations.getByRunId("parent-run", "preflight")).resolves.toMatchObject({ status: "cancelled" })
  })

  it("allocates separate journal identities for fresh failed starts", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const failure = new Error("Preparation failed")
    setAgentWorkflowRuntimeLoaders({ state: async () => { throw failure }, workflow: () => import("@vite-hub/workflow") })
    const agent = defineAgent({ driver: { run: () => "unreachable" }, invocations, name: "preflight", runtime: workflow("preflight") })
    await Promise.all([1, 2].map(async () => {
      await expect(startAgentInvocation(agent, runtime(), {})).rejects.toBe(failure)
    }))
    const page = await invocations.list()
    expect(page.invocations).toHaveLength(2)
    expect(new Set(page.invocations.map(record => record.id)).size).toBe(2)
    expect(page.invocations.every(record => record.status === "failed")).toBe(true)
    await expect(invocations.getByRunId("parent-run", "preflight")).resolves.toBeUndefined()
  })

  it("preserves the durable delivery identity for fresh failed handoffs", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const failure = new Error("Preparation failed")
    setAgentWorkflowRuntimeLoaders({ state: async () => { throw failure }, workflow: () => import("@vite-hub/workflow") })
    const agent = defineAgent({ driver: { run: () => "unreachable" }, invocations, name: "preflight", runtime: workflow("preflight") })
    const input = { context: { "vitehub.channelDelivery": {
      channelId: "telegram", deliveryId: "delivery", provider: "telegram", state: "chat",
    } } }
    await expect(startAgentInvocation(agent, runtime(), input)).rejects.toBe(failure)
    await expect(invocations.getByRunId("parent-run", "preflight")).resolves.toMatchObject({ status: "failed" })
    await expect(invocations.list()).resolves.toMatchObject({ invocations: [expect.objectContaining({ status: "failed" })] })
  })

  it("preserves the preparation error when persistence also fails", async () => {
    const store = createMemoryAgentInvocationStore()
    const persistenceFailure = new Error("Journal unavailable")
    store.create = vi.fn(async () => { throw persistenceFailure })
    const invocations = defineAgentInvocations({ store })
    const failure = new Error("Preparation failed")
    setAgentWorkflowRuntimeLoaders({ state: async () => { throw failure }, workflow: () => import("@vite-hub/workflow") })
    const agent = defineAgent({ driver: { run: () => "unreachable" }, invocations, runtime: workflow("preflight") })
    await expect(runAgent(agent, runtime(), {})).rejects.toBe(failure)
    expect(store.create).toHaveBeenCalled()
  })
})

describe("Workflow delivery lock portability", () => {
  it("copies RPC lock fields without carrying the remote prototype", async () => {
    class RemoteLock {
      expiresAt = 123456
      threadId = "telegram:calories"
      token = "lock-token"
      close = () => { throw new Error("Runtime methods must not run") }
    }
    const lock = new RemoteLock()
    const input = { context: { "vitehub.channelDelivery": {
      channelId: "telegram",
      deliveryId: "delivery-id",
      provider: "telegram",
      state: "chat",
      steer: { claimId: "claim", lock, pendingQueue: "pending", queue: "queue", ttlMs: 300000 },
    } } }
    const portable = await portableAgentWorkflowInput(input)
    expect(portable.context?.["vitehub.channelDelivery"]).toMatchObject({
      steer: { lock: { expiresAt: 123456, threadId: "telegram:calories", token: "lock-token" } },
    })
    expect(JSON.stringify(portable)).not.toContain("close")
    expect(input.context["vitehub.channelDelivery"].steer.lock).toBe(lock)
  })

  it("keeps invalid lock fields and unrelated user context subject to JSON validation", async () => {
    const binding = { deliveryId: "delivery-id", provider: "telegram", state: "chat" }
    await expect(portableAgentWorkflowInput({ context: { "vitehub.channelDelivery": {
      ...binding,
      steer: { lock: { expiresAt: 123, threadId: "telegram", token: () => "invalid" } },
    } } })).rejects.toThrow("JSON-compatible")
    await expect(portableAgentWorkflowInput({ context: { userLock: new Date() } })).rejects.toThrow("JSON-compatible")
  })
})

it.each(["preparation", "provider-preparation", "provider"] as const)("signals input handoff only when reaching the runtime: %s", async (stage) => {
  const failure = new Error("Startup failed")
  const onInputHandoff = vi.fn()
  const providerRun = vi.fn(async () => {
    const state = await import("@vite-hub/workflow/runtime/state")
    // SAFETY: startAgentInvocation owns the event surrounding this mocked Workflow handle.
    const event = state.getWorkflowRuntimeEvent() as { onDispatch?: () => void }
    expect(onInputHandoff).not.toHaveBeenCalled()
    if (stage === "provider") {
      event.onDispatch?.()
      // A recovery Workflow can reuse the event without taking input ownership again.
      event.onDispatch?.()
    }
    throw failure
  })
  setAgentWorkflowRuntimeLoaders({
    state: stage === "preparation" ? async () => { throw failure } : workflowState,
    workflow: async () => ({
      ...await import("@vite-hub/workflow"),
      // SAFETY: The provider fails before returning a run; no other handle operations are used.
      createWorkflow: () => ({ run: providerRun }) as never,
    }),
  })
  const agent = defineAgent({ driver: { run: () => "unreachable" }, name: "handoff", runtime: workflow("handoff") })
  await expect(startAgentInvocation(agent, runtime(), {}, { onInputHandoff })).rejects.toBe(failure)
  expect(onInputHandoff).toHaveBeenCalledTimes(stage === "provider" ? 1 : 0)
  expect(providerRun).toHaveBeenCalledTimes(stage === "preparation" ? 0 : 1)
})

it("signals inline input handoff before executing the Driver", async () => {
  const onInputHandoff = vi.fn()
  const agent = defineAgent({ driver: { run: () => {
    expect(onInputHandoff).toHaveBeenCalledOnce()
    return "done"
  } } })
  await startAgentInvocation(agent, runtime(), {}, { onInputHandoff })
  expect(onInputHandoff).toHaveBeenCalledOnce()
})
