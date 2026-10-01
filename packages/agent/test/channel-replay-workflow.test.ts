import { afterEach, expect, it, vi } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../../source/src/index.ts"
import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { defineAgent, runAgentInline, workflow } from "../src/index.ts"
import { setAgentWorkflowRuntimeLoaders } from "../src/internal/workflow-runtime-loaders.ts"
import { bindAgentInvocations, createMemoryAgentInvocationStore, defineAgentInvocations, pendingAgentInvocationAnnotation } from "../src/invocations.ts"
import { runAgentWorkflowDefinition } from "../src/runtime/workflow.ts"
import { channelReplayRunId, replayChannel } from "../src/channel-replay.ts"

afterEach(() => {
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
          return { input: { prompt: "hello" }, run: { runId: "trigger-run", channelId: "mailbox", origin: "history-trigger", threadId: "message-thread", annotations: { trigger: "history" }, activity: { target: { message: "m1" } } } }
        },
      }),
    },
  })
  const providerRun = vi.fn(async (payload: { invocationClaimToken?: string }, options: { id: string }) => {
    expect(await invocations.getByRunId(options.id, "replay-workflow")).toMatchObject({ channelId: "mailbox", origin: "history-trigger", threadId: "message-thread", annotations: { trigger: "history" } })
    const workerJournal = await bindAgentInvocations(invocations, { ...runtime, run: { runId: options.id } }, { agentName: "replay-workflow", replaceClaimToken: payload.invocationClaimToken })
    expect(workerJournal?.claimStatus).toBe("owned")
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
  expect(results.reduce((sum, result) => sum + result.skipped, 0)).toBe(1)
  expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0)
  await expect(invocations.getByRunId(channelReplayRunId("mailbox", "m1"), "replay-workflow")).resolves.toMatchObject({ status: "completed" })
})

it("recovers discovery-default replay inline when Workflow is disabled", async () => {
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {}, agentIdentity: { name: "inline-recovery" } }
  const driver = vi.fn(() => "done")
  const channel = defineChannel("mailbox", {
    history: { collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }), key: item => item.id },
    triggers: { received: defineChannelTrigger({ input: v.object({ id: v.string() }), invoke: () => ({ input: { prompt: "hello" } }) }) },
  })
  const createWorkflow = vi.fn(() => { throw new Error("Workflow is disabled") })
  setAgentWorkflowRuntimeLoaders({
    state: async () => ({ ...await import("@vite-hub/workflow/runtime/state"), getWorkflowRuntimeConfig: () => false }),
    workflow: async () => ({ ...await import("@vite-hub/workflow"), createWorkflow }) as never,
  })
  const agent = defineAgent({ channels: { mailbox: channel }, driver: { run: driver }, invocations, name: "inline-recovery" })
  await expect(replayChannel(agent, "mailbox", { runtime })).resolves.toMatchObject({ processed: 1, failed: 0 })
  expect(driver).toHaveBeenCalledOnce()
  expect(createWorkflow).not.toHaveBeenCalled()
})

it("does not pass replay IDs to native Vercel Workflows", async () => {
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
  const channel = defineChannel("mailbox", {
    history: { collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }), key: item => item.id },
    triggers: { received: defineChannelTrigger({ input: v.object({ id: v.string() }), invoke: () => ({ input: { prompt: "hello" } }) }) },
  })
  const providerRun = vi.fn(async (_payload: unknown, options: { id?: string }) => {
    expect(options).toEqual({})
    return { id: "vercel-assigned", provider: "vercel" as const, status: "queued" as const }
  })
  setAgentWorkflowRuntimeLoaders({
    state: async () => ({ ...await import("@vite-hub/workflow/runtime/state"), getWorkflowRuntimeConfig: () => ({ provider: "vercel" as const }) }),
    workflow: async () => ({
      ...await import("@vite-hub/workflow"),
      createWorkflow: () => ({ getRun: async (id: string) => ({ id, provider: "vercel", status: "unknown" }), run: providerRun }) as never,
    }),
  })
  const agent = defineAgent({ channels: { mailbox: channel }, driver: { run: () => "unused" }, invocations, name: "vercel-replay", runtime: workflow("vercel-replay") })
  await expect(replayChannel(agent, "mailbox", { runtime })).resolves.toMatchObject({ processed: 1, failed: 0 })
  expect(providerRun).toHaveBeenCalledOnce()
  await expect(invocations.getByRunId(channelReplayRunId("mailbox", "m1"), "vercel-replay")).resolves.toMatchObject({ status: "pending" })
})

it("does not redispatch an unconfirmed native Vercel replay after its lease expires", async () => {
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
  const channel = defineChannel("mailbox", {
    history: { collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }), key: item => item.id },
    triggers: { received: defineChannelTrigger({ input: v.object({ id: v.string() }), invoke: () => ({ input: { prompt: "hello" } }) }) },
  })
  const providerRun = vi.fn(async (_payload: unknown) => ({ id: "vercel-assigned", provider: "vercel", status: "queued" }))
  const getRun = vi.fn(async (id: string) => ({ id, provider: "vercel", status: "unknown" }))
  setAgentWorkflowRuntimeLoaders({
    state: async () => ({ ...await import("@vite-hub/workflow/runtime/state"), getWorkflowRuntimeConfig: () => ({ provider: "vercel" as const }) }),
    workflow: async () => ({ ...await import("@vite-hub/workflow"),
      // SAFETY: The fixture only uses Workflow dispatch and lookup.
      createWorkflow: () => ({ getRun, run: providerRun }) as never,
    }),
  })
  const agent = defineAgent({ channels: { mailbox: channel }, driver: { run: () => "unused" }, invocations, name: "vercel-recovery", runtime: workflow("vercel-recovery") })
  vi.useFakeTimers()
  try {
    const reservation = await bindAgentInvocations(invocations, { ...runtime, run: { runId: channelReplayRunId("mailbox", "m1"), annotations: { [pendingAgentInvocationAnnotation]: true } } }, { agentName: "vercel-recovery", recoverPending: true })
    const invocationClaimToken = await reservation?.handoffClaim()
    // The provider accepted the run, but the caller exited before confirming dispatch.
    await providerRun({ invocationClaimToken })
    await vi.advanceTimersByTimeAsync(30_001)
    await expect(replayChannel(agent, "mailbox", { runtime })).resolves.toMatchObject({ processed: 0, skipped: 1, failed: 0 })
    expect(providerRun).toHaveBeenCalledOnce()
    expect(getRun).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})

it("recovers an undispatched Workflow reservation after process loss and keeps confirmed dispatch skipped", async () => {
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
    const reservation = await bindAgentInvocations(invocations, { ...runtime, run: { runId: channelReplayRunId("mailbox", "m1"), annotations: { [pendingAgentInvocationAnnotation]: true } } }, { agentName: "recover-workflow", recoverPending: true })
    expect(reservation?.claimStatus).toBe("owned")
    // Simulate the reserving process exiting before provider dispatch, leaving its lease to expire.
    await reservation?.handoffClaim()
    expect((await replayChannel(agent, "mailbox", { runtime })).skipped).toBe(1)
    await vi.advanceTimersByTimeAsync(30_001)
    const results = await Promise.all([replayChannel(agent, "mailbox", { runtime }), replayChannel(agent, "mailbox", { runtime })])
    expect(providerRun).toHaveBeenCalledOnce()
    expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(1)
    expect(results.reduce((sum, result) => sum + result.skipped, 0)).toBe(1)
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

it("reconciles an accepted provider run when dispatch confirmation times out", async () => {
  const store = createMemoryAgentInvocationStore()
  let failConfirmation = true
  const invocations = defineAgentInvocations({ store: { ...store,
    update: async (...args: Parameters<typeof store.update>) => {
      if (failConfirmation && args[1].annotations?.[pendingAgentInvocationAnnotation] === false) throw new Error("Store unavailable")
      return await store.update(...args)
    },
  } })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {} }
  const channel = defineChannel("mailbox", {
    history: { collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }), key: item => item.id },
    triggers: { received: defineChannelTrigger({ input: v.object({ id: v.string() }), invoke: () => ({ input: { prompt: "hello" } }) }) },
  })
  const providerRun = vi.fn(async (_payload: unknown, options: { id: string }) => ({ id: options.id, provider: "openworkflow", status: "queued" }))
  const getRun = vi.fn(async (id: string) => ({ id, provider: "openworkflow", status: "queued" }))
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
    expect((await replayChannel(agent, "mailbox", { runtime })).processed).toBe(1)
    expect((await invocations.getByRunId(channelReplayRunId("mailbox", "m1"), "confirm-workflow"))?.annotations?.[pendingAgentInvocationAnnotation]).toBe(true)
    await vi.advanceTimersByTimeAsync(30_001)
    failConfirmation = false
    expect((await replayChannel(agent, "mailbox", { runtime })).skipped).toBe(1)
    expect(getRun).toHaveBeenCalledOnce()
    expect(providerRun).toHaveBeenCalledOnce()
    expect((await invocations.getByRunId(channelReplayRunId("mailbox", "m1"), "confirm-workflow"))?.annotations?.[pendingAgentInvocationAnnotation]).toBe(false)
  } finally { vi.useRealTimers() }
})
