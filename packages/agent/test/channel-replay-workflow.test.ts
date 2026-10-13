import { afterEach, expect, it, vi } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../../source/src/index.ts"
import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { defineAgent, runAgentInline, workflow } from "../src/index.ts"
import { setAgentWorkflowRuntimeLoaders } from "../src/internal/workflow-runtime-loaders.ts"
import { bindAgentInvocations, createMemoryAgentInvocationStore, defineAgentInvocations, pendingAgentInvocationAnnotation, pendingAgentInvocationAnnotations, workflowDispatchAttemptedAnnotation } from "../src/invocations.ts"
import { runAgentWorkflowDefinition } from "../src/runtime/workflow.ts"
import { channelMessageRunId, replayChannel } from "../src/channel-replay.ts"

afterEach(() => {
  vi.useRealTimers()
  setAgentWorkflowRuntimeLoaders({
    state: () => import("@vite-hub/workflow/runtime/state"),
    workflow: () => import("@vite-hub/workflow"),
  })
})

it("reserves concurrent Workflow replays before activity and hands the journal to the worker", async () => {
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
  let entered = 0
  const update = vi.fn()
  const channel = defineChannel("mailbox", {
    activity: { update },
    history: {
      collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }),
      key: item => item.id,
    },
    triggers: {
      received: defineChannelTrigger({
        input: v.object({ id: v.string() }),
        invoke: async () => {
          entered++
          return { input: { prompt: "hello" }, run: { runId: "trigger-run", channelId: "mailbox", activity: { target: { message: "m1" } } } }
        },
      }),
    },
  })
  const providerRun = vi.fn(async (payload: { invocationClaimToken?: string }, options: { id: string }) => {
    const workerJournal = await bindAgentInvocations(invocations, { ...runtime, run: { runId: options.id } }, { agentName: "replay-workflow", replaceClaimToken: payload.invocationClaimToken })
    expect(workerJournal?.claimStatus).toBe("owned")
    expect(await workerJournal?.confirmWorkflowDispatch()).toBe(true)
    await workerJournal?.running()
    const duplicateWorker = await bindAgentInvocations(invocations, { ...runtime, run: { runId: options.id } }, { agentName: "replay-workflow", replaceClaimToken: payload.invocationClaimToken })
    expect(duplicateWorker?.claimStatus).toBe("conflict")
    await workerJournal?.finish("completed")
    return { id: options.id, provider: "vercel", status: "completed", result: "done" }
  })
  setAgentWorkflowRuntimeLoaders({
    state: async () => ({ ...await import("@vite-hub/workflow/runtime/state"), getWorkflowRuntimeConfig: () => ({ provider: "openworkflow" as const }) }),
    workflow: async () => ({
      ...await import("@vite-hub/workflow"),
      // SAFETY: The fixture only uses the Workflow handle's run operation.
      createWorkflow: () => ({ getRun: async (id: string) => ({ id, provider: "openworkflow", status: "unknown" }), run: providerRun }) as never,
    }),
  })
  const agent = defineAgent({ channels: { mailbox: channel }, driver: { run: () => "unused" }, invocations, name: "replay-workflow", runtime: workflow("replay-workflow") })
  const results = await Promise.all([replayChannel(agent, "mailbox", { runtime }), replayChannel(agent, "mailbox", { runtime })])
  expect(update.mock.calls.filter(([context]) => context.activity.status === "queued")).toHaveLength(1)
  expect(entered).toBe(1)
  expect(providerRun).toHaveBeenCalledTimes(1)
  expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(1)
  expect(results.reduce((sum, result) => sum + result.skipped + result.failed, 0)).toBe(1)
  await expect(invocations.getByRunId(channelMessageRunId("mailbox", "m1"), "replay-workflow")).resolves.toMatchObject({ status: "completed" })
})

it("records durable replay cancellation observed before provider dispatch", async () => {
  const backing = createMemoryAgentInvocationStore()
  let cancellationRequested = false
  const store = {
    ...backing,
    getSummary: async (id: string) => {
      const record = await backing.getSummary(id)
      return cancellationRequested && record ? { ...record, cancelRequestedAt: new Date().toISOString() } : record
    },
  }
  const invocations = defineAgentInvocations({ store })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
  const update = vi.fn()
  const channel = defineChannel("mailbox", {
    activity: { update },
    history: { collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }), key: item => item.id },
    triggers: { received: defineChannelTrigger({ input: v.object({ id: v.string() }), invoke: () => ({ input: { prompt: "hello" } }) }) },
  })
  const runId = channelMessageRunId("mailbox", "m1")
  const providerRun = vi.fn(async () => ({ id: "workflow-should-not-start", provider: "openworkflow", status: "queued" }))
  setAgentWorkflowRuntimeLoaders({
    state: async () => ({ ...await import("@vite-hub/workflow/runtime/state"), getWorkflowRuntimeConfig: () => ({ provider: "openworkflow" as const }) }),
    workflow: async () => ({
      ...await import("@vite-hub/workflow"),
      createWorkflow: () => {
        // Simulate another process persisting cancellation in the dispatch window.
        cancellationRequested = true
        return { getRun: async (id: string) => ({ id, provider: "openworkflow", status: "unknown" }), run: providerRun }
      },
    }) as never,
  })
  const agent = defineAgent({ channels: { mailbox: channel }, driver: { run: () => "unused" }, invocations, name: "cancelled-replay", runtime: workflow("cancelled-replay") })
  expect(await replayChannel(agent, "mailbox", { runtime })).toMatchObject({ failed: 1, processed: 0 })
  expect(providerRun).not.toHaveBeenCalled()
  await expect(invocations.getByRunId(runId, "cancelled-replay")).resolves.toMatchObject({ status: "cancelled" })
})

it.each([true, false])("recovers an expired Workflow reservation only when no dispatch attempt is recorded: %s", async explicit => {
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
  const channel = defineChannel("mailbox", {
    history: { collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }), key: item => item.id },
    triggers: { received: defineChannelTrigger({ input: v.object({ id: v.string() }), invoke: () => ({ input: { prompt: "hello" } }) }) },
  })
  const providerRun = vi.fn(async (payload: { invocationClaimToken?: string }, options: { id: string }) => {
    expect(payload.invocationClaimToken).toEqual(expect.any(String))
    return { id: options.id, provider: "vercel", status: "queued" }
  })
  setAgentWorkflowRuntimeLoaders({
    state: async () => ({ ...await import("@vite-hub/workflow/runtime/state"), getWorkflowRuntimeConfig: () => ({ provider: "openworkflow" as const }) }),
    workflow: async () => ({ ...await import("@vite-hub/workflow"),
      // SAFETY: The test only needs the Workflow run operation.
      createWorkflow: () => ({ getRun: async (id: string) => ({ id, provider: "openworkflow", status: "unknown" }), run: providerRun }) as never,
    }),
  })
  const agent = defineAgent({ channels: { mailbox: channel }, driver: { run: () => "unused" }, invocations, name: "recover-workflow", runtime: workflow("recover-workflow") })
  vi.useFakeTimers()
  try {
    const reservation = await bindAgentInvocations(invocations, { ...runtime, run: { runId: channelMessageRunId("mailbox", "m1"), annotations: explicit ? pendingAgentInvocationAnnotations({}) : { [pendingAgentInvocationAnnotation]: true } } }, { agentName: "recover-workflow", recoverPending: true })
    expect(reservation?.claimStatus).toBe("owned")
    // Simulate the reserving process exiting before provider dispatch, leaving its lease to expire.
    await reservation?.handoffClaim()
    expect(await replayChannel(agent, "mailbox", { runtime })).toMatchObject({ failed: 1, processed: 0, skipped: 0 })
    await vi.advanceTimersByTimeAsync(30_001)
    const results = await Promise.all([replayChannel(agent, "mailbox", { runtime }), replayChannel(agent, "mailbox", { runtime })])
    if (!explicit) {
      expect(results.every(result => result.failed === 1 && result.processed === 0)).toBe(true)
      expect(providerRun).not.toHaveBeenCalled()
      return
    }
    expect(providerRun).toHaveBeenCalledOnce()
    expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(1)
    expect(results.reduce((sum, result) => sum + result.skipped + result.failed, 0)).toBe(1)
    await vi.advanceTimersByTimeAsync(30_001)
    expect((await replayChannel(agent, "mailbox", { runtime })).skipped).toBe(1)
    expect(providerRun).toHaveBeenCalledOnce()
  } finally { vi.useRealTimers() }
})

it("adopts a dispatch claim in the real worker before Driver execution", async () => {
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const running = new Promise<void>(resolve => { entered = resolve })
  const driver = vi.fn(async () => { entered(); await gate; return "done" })
  const agent = defineAgent({ driver: { run: driver }, invocations, name: "handoff-worker", runtime: false })
  const reservation = await bindAgentInvocations(invocations, { ...runtime, run: { runId: "handoff-worker-run", annotations: { [pendingAgentInvocationAnnotation]: true } } }, { agentName: "handoff-worker", recoverPending: true })
  const token = await reservation?.handoffClaim()
  expect(token).toEqual(expect.any(String))
  const context = { id: "handoff-worker-run", name: "handoff-worker", payload: { invocationClaimToken: token, input: { prompt: "hello" } }, provider: "openworkflow" as const }
  const execution = runAgentWorkflowDefinition(agent, context, (definition, runtime, input) => runAgentInline(definition, runtime, input))
  try {
    await Promise.race([running, execution])
    expect(await reservation?.handoffClaim()).toBeUndefined()
    await reservation?.releaseClaim()
    await expect(runAgentWorkflowDefinition(agent, context, (definition, runtime, input) => runAgentInline(definition, runtime, input))).rejects.toThrow("Invocation already exists or is claimed")
    expect(driver).toHaveBeenCalledOnce()
    release()
    await execution
  } finally { release(); await execution.catch(() => undefined) }
})

it("keeps the real Workflow worker claim after delayed heartbeat cleanup", async () => {
  vi.useFakeTimers()
  const memory = createMemoryAgentInvocationStore()
  let releaseResponse!: () => void
  const claim = vi.fn(async (...args: Parameters<typeof memory.claim>) => {
    const owned = await memory.claim(...args)
    if (claim.mock.calls.length === 2) await new Promise<void>(resolve => { releaseResponse = resolve })
    return owned
  })
  const invocations = defineAgentInvocations({ store: { ...memory, claim } })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
  const driver = vi.fn(() => "done")
  const agent = defineAgent({ driver: { run: driver }, invocations, name: "late-heartbeat-worker", runtime: false })
  const binding = { ...runtime, run: { runId: "late-heartbeat-worker-run", annotations: { [pendingAgentInvocationAnnotation]: true } } }
  const reservation = await bindAgentInvocations(invocations, binding, { agentName: "late-heartbeat-worker", recoverPending: true })
  await vi.advanceTimersByTimeAsync(11_000)
  const token = await reservation?.handoffClaim()
  expect(token).toEqual(expect.any(String))
  releaseResponse()
  await reservation?.context.traceLog?.append({ name: "queued-after-handoff", type: "run" })
  await vi.advanceTimersByTimeAsync(0)
  const record = (await invocations.getByRunId("late-heartbeat-worker-run", "late-heartbeat-worker"))!
  expect(await memory.getClaimToken(record.id)).toBe(token)
  const duplicate = await bindAgentInvocations(invocations, binding, { agentName: "late-heartbeat-worker", recoverPending: true })
  expect(duplicate?.claimStatus).toBe("conflict")
  const context = { id: "late-heartbeat-worker-run", name: "late-heartbeat-worker", payload: { invocationClaimToken: token, input: { prompt: "hello" } }, provider: "openworkflow" as const }
  await expect(runAgentWorkflowDefinition(agent, context, runAgentInline)).resolves.toBe("done")
  expect(driver).toHaveBeenCalledOnce()
  expect(await reservation?.handoffClaim()).toBeUndefined()
  await reservation?.releaseClaim()
})

it.each(["queued", "unknown", "unavailable-marker"] as const)("reconciles an accepted provider run when dispatch confirmation times out and lookup is %s", async initialStatus => {
  const store = createMemoryAgentInvocationStore()
  let failConfirmation = true
  let recovery = false
  const invocations = defineAgentInvocations({ store: { ...store,
    create: async (...args: Parameters<typeof store.create>) => {
      const result = await store.create(...args)
      if (result && !result.created && recovery && initialStatus === "unknown") {
        // The marker committed after the recovery process read this snapshot.
        const annotations = { ...result.record.annotations }
        delete annotations[workflowDispatchAttemptedAnnotation]
        return { ...result, record: { ...result.record, annotations } }
      }
      return result
    },
    getSummary: async (...args: Parameters<typeof store.getSummary>) => {
      if (recovery && initialStatus === "unavailable-marker") throw new Error("Store unavailable")
      return await store.getSummary(...args)
    },
    update: async (...args: Parameters<typeof store.update>) => {
      if (failConfirmation && args[1].annotations?.[pendingAgentInvocationAnnotation] === false) throw new Error("Store unavailable")
      return await store.update(...args)
    },
  } })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {}, run: { runId: "reconciliation-request", annotations: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`caller-${index}`, index])) } }
  const channel = defineChannel("mailbox", {
    history: { collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }), key: item => item.id },
    triggers: { received: defineChannelTrigger({ input: v.object({ id: v.string() }), invoke: () => ({ input: { prompt: "hello" } }) }) },
  })
  const providerRun = vi.fn(async (_payload: unknown, options: { id: string }) => ({ id: options.id, provider: "openworkflow", status: "queued" }))
  let lookups = 0
  const getRun = vi.fn(async (id: string) => ({ id, provider: "openworkflow", status: ++lookups === 1 && initialStatus !== "queued" ? "unknown" : "queued" }))
  setAgentWorkflowRuntimeLoaders({
    state: async () => ({ ...await import("@vite-hub/workflow/runtime/state"), getWorkflowRuntimeConfig: () => ({ provider: "openworkflow" as const }) }),
    workflow: async () => ({ ...await import("@vite-hub/workflow"),
      // SAFETY: This fixture implements the run and lookup operations used by replay recovery.
      createWorkflow: () => ({ getRun, run: providerRun }) as never,
    }),
  })
  const agent = defineAgent({ channels: { mailbox: channel }, driver: { run: () => "unused" }, invocations, name: "confirm-workflow", runtime: workflow("confirm-workflow") })
  vi.useFakeTimers()
  try {
    const dispatch = await replayChannel(agent, "mailbox", { runtime })
    expect(dispatch.failed).toBe(1)
    expect(dispatch.items[0]?.error).toContain("Could not confirm the Workflow Invocation dispatch")
    const pending = await invocations.getByRunId(channelMessageRunId("mailbox", "m1"), "confirm-workflow")
    expect(Object.keys(pending?.annotations || {})).toHaveLength(32)
    expect(pending?.annotations).toMatchObject({ [pendingAgentInvocationAnnotation]: true, [workflowDispatchAttemptedAnnotation]: true })
    expect((await invocations.getByRunId(channelMessageRunId("mailbox", "m1"), "confirm-workflow"))?.annotations?.[pendingAgentInvocationAnnotation]).toBe(true)
    await vi.advanceTimersByTimeAsync(30_001)
    failConfirmation = false
    recovery = true
    if (initialStatus === "unavailable-marker" || initialStatus === "unknown") {
      expect((await replayChannel(agent, "mailbox", { runtime })).failed).toBe(1)
      expect(providerRun).toHaveBeenCalledOnce()
      expect((await invocations.getByRunId(channelMessageRunId("mailbox", "m1"), "confirm-workflow"))?.annotations?.[pendingAgentInvocationAnnotation]).toBe(true)
      return
    }
    expect((await replayChannel(agent, "mailbox", { runtime })).skipped).toBe(1)
    expect(getRun).toHaveBeenCalledTimes(initialStatus !== "queued" ? 2 : 1)
    expect(providerRun).toHaveBeenCalledOnce()
    expect((await invocations.getByRunId(channelMessageRunId("mailbox", "m1"), "confirm-workflow"))?.annotations?.[pendingAgentInvocationAnnotation]).toBe(false)
    if (initialStatus !== "queued") {
      expect(await replayChannel(agent, "mailbox", { runtime, force: true })).toMatchObject({ processed: 1, failed: 0 })
      expect(providerRun).toHaveBeenCalledTimes(2)
      expect(providerRun.mock.calls[1]?.[1].id).not.toBe(providerRun.mock.calls[0]?.[1].id)
      expect(getRun).toHaveBeenCalledTimes(2)
    }
  } finally { vi.useRealTimers() }
})


it.each(["rejected", "timeout", "committed-timeout"] as const)("prevents provider dispatch when its durable attempt write is %s", async failure => {
  vi.useFakeTimers()
  const memory = createMemoryAgentInvocationStore()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let rejectAttempt = true
  const invocations = defineAgentInvocations({ store: { ...memory,
    update: async (...args: Parameters<typeof memory.update>) => {
      if (rejectAttempt && args[1].annotations?.[workflowDispatchAttemptedAnnotation] === true) {
        entered()
        if (failure === "committed-timeout") await memory.update(...args)
        if (failure !== "rejected") return await new Promise<never>(() => {})
        throw new Error("Store unavailable")
      }
      return await memory.update(...args)
    },
  } })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
  const channel = defineChannel("mailbox", {
    history: { collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }), key: item => item.id },
    triggers: { received: defineChannelTrigger({ input: v.object({ id: v.string() }), invoke: () => ({ input: { prompt: "hello" } }) }) },
  })
  const providerRun = vi.fn(async (_payload: unknown, options: { id: string }) => ({ id: options.id, provider: "openworkflow", status: "queued" }))
  setAgentWorkflowRuntimeLoaders({
    state: async () => ({ ...await import("@vite-hub/workflow/runtime/state"), getWorkflowRuntimeConfig: () => ({ provider: "openworkflow" as const }) }),
    workflow: async () => ({ ...await import("@vite-hub/workflow"),
      // SAFETY: This fixture implements the run and lookup operations used by replay recovery.
      createWorkflow: () => ({ getRun: async (id: string) => ({ id, provider: "openworkflow", status: "unknown" }), run: providerRun }) as never,
    }),
  })
  const agent = defineAgent({ channels: { mailbox: channel }, driver: { run: () => "unused" }, invocations, name: "attempt-write-workflow", runtime: workflow("attempt-write-workflow") })
  const dispatch = replayChannel(agent, "mailbox", { runtime })
  await started
  if (failure !== "rejected") await vi.advanceTimersByTimeAsync(1_000)
  expect(await dispatch).toMatchObject({ failed: 1, processed: 0 })
  expect(providerRun).not.toHaveBeenCalled()
  expect(await invocations.getByRunId(channelMessageRunId("mailbox", "m1"), "attempt-write-workflow")).toMatchObject({ status: "pending", annotations: { [pendingAgentInvocationAnnotation]: true } })
  rejectAttempt = false
  await vi.advanceTimersByTimeAsync(30_001)
  if (failure === "committed-timeout") {
    expect(await replayChannel(agent, "mailbox", { runtime })).toMatchObject({ failed: 1, processed: 0 })
    expect(providerRun).not.toHaveBeenCalled()
    const forced = await replayChannel(agent, "mailbox", { runtime, force: true })
    expect(forced).toMatchObject({ failed: 0, processed: 1 })
    expect(forced.items[0]?.id).not.toBe(channelMessageRunId("mailbox", "m1"))
  } else {
    expect(await replayChannel(agent, "mailbox", { runtime })).toMatchObject({ failed: 0, processed: 1 })
  }
  expect(providerRun).toHaveBeenCalledOnce()
})

it.each(["provider", "preparation"] as const)("retains terminal journaling for a definite %s failure", async failure => {
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
  const channel = defineChannel("mailbox", {
    history: { collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }), key: item => item.id },
    triggers: { received: defineChannelTrigger({ input: v.object({ id: v.string() }), invoke: () => ({ input: { prompt: "hello", ...(failure === "preparation" ? { context: { invalid: () => {} } } : {}) } }) }) },
  })
  const providerRun = vi.fn(async () => { throw new Error("Provider rejected the run") })
  const getRun = vi.fn()
  setAgentWorkflowRuntimeLoaders({
    state: async () => ({ ...await import("@vite-hub/workflow/runtime/state"), getWorkflowRuntimeConfig: () => ({ provider: "openworkflow" as const }) }),
    workflow: async () => ({ ...await import("@vite-hub/workflow"),
      // SAFETY: This fixture implements the run and lookup operations used by replay recovery.
      createWorkflow: () => ({ getRun, run: providerRun }) as never,
    }),
  })
  const agent = defineAgent({ channels: { mailbox: channel }, driver: { run: () => "unused" }, invocations, name: "definite-failure-workflow", runtime: workflow("definite-failure-workflow") })
  expect(await replayChannel(agent, "mailbox", { runtime })).toMatchObject({ failed: 1, processed: 0 })
  const record = await invocations.getByRunId(channelMessageRunId("mailbox", "m1"), "definite-failure-workflow")
  expect(record?.status).toBe("failed")
  expect(record?.annotations?.[workflowDispatchAttemptedAnnotation]).toBe(failure === "provider")
  expect(providerRun).toHaveBeenCalledTimes(failure === "provider" ? 1 : 0)
  expect(await replayChannel(agent, "mailbox", { runtime })).toMatchObject({ skipped: 1, processed: 0 })
  expect(getRun).not.toHaveBeenCalled()
})
