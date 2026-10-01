import { afterEach, expect, it, vi } from "vitest"
import * as v from "valibot"
import { getAgentInvocationRecoveryWorkflowName } from "@vite-hub/internal/agent-workflow"
import { defineCollection } from "../../source/src/index.ts"
import { createWorkflow } from "../../workflow/src/index.ts"
import { setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../../workflow/src/runtime/state.ts"
import { setVercelWorkflowRuntimeLoader, type VercelRun, type VercelWorkflowRuntime } from "../../workflow/src/runtime/vercel.ts"
import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { channelReplayRunId, replayChannel } from "../src/channel-replay.ts"
import { defineAgent, runAgentInline, workflow } from "../src/index.ts"
import { setAgentWorkflowRuntimeLoaders } from "../src/internal/workflow-runtime-loaders.ts"
import { bindAgentInvocations, createMemoryAgentInvocationStore, defineAgentInvocations, pendingAgentInvocationAnnotation } from "../src/invocations.ts"
import { runAgentWorkflowDefinition } from "../src/runtime/workflow.ts"

afterEach(() => {
  vi.useRealTimers()
  setWorkflowRuntimeConfig(undefined)
  setWorkflowRuntimeRegistry(undefined)
  setVercelWorkflowRuntimeLoader()
  setAgentWorkflowRuntimeLoaders({ state: () => import("@vite-hub/workflow/runtime/state"), workflow: () => import("@vite-hub/workflow") })
})

function fixture(options: { rejectAcknowledgement?: boolean, failConfirmation?: boolean, executeWorker?: boolean, failIntent?: boolean, failRuntimeLoad?: boolean, discoveryDefault?: boolean, inline?: boolean } = {}) {
  const name = "native-replay"
  const native = Object.assign(async () => "done", { workflowId: "workflow/native-replay" })
  const recoveryNative = Object.assign(async () => {}, { workflowId: "workflow/native-replay-recovery" })
  const memory = createMemoryAgentInvocationStore()
  let failConfirmation = Boolean(options.failConfirmation)
  const store = { ...memory, update: memory.update }
  store.update = (id, input, claimId) => {
    if (options.failIntent && input.workflow && !input.workflow.id) throw new Error("Intent unavailable")
    if (failConfirmation && input.annotations?.[pendingAgentInvocationAnnotation] === false) throw new Error("Confirmation unavailable")
    return memory.update(id, input, claimId)
  }
  const invocations = defineAgentInvocations({ store })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: () => {}, agentIdentity: { name } }
  const driver = vi.fn(() => "done")
  const channel = defineChannel("mailbox", {
    history: { collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }), key: item => item.id },
    triggers: { received: defineChannelTrigger({ input: v.object({ id: v.string() }), invoke: () => ({ input: { prompt: "hello" } }) }) },
  })
  const agent = defineAgent({ channels: { mailbox: channel }, driver: { run: driver }, invocations, name, ...(options.inline ? { runtime: false as const } : options.discoveryDefault ? {} : { runtime: workflow(name) }) })
  const runs = new Map<string, VercelRun>()
  const statuses = new Map<string, string>()
  const cancel = vi.fn(async (id: string) => { statuses.set(id, "cancelled") })
  const makeRun = (id: string, workflowName: string, exists = true): VercelRun => ({
    cancel: () => cancel(id), completedAt: Promise.resolve(undefined), createdAt: Promise.resolve(new Date()), exists: Promise.resolve(exists),
    returnValue: new Promise(() => {}), runId: id, startedAt: Promise.resolve(undefined), get status() { return Promise.resolve(statuses.get(id) || "pending") }, workflowName: Promise.resolve(workflowName),
  })
  const start: VercelWorkflowRuntime["start"] = vi.fn(async (handler, args) => {
    const isPrimary = handler === native
    const run = makeRun(`wrun_${runs.size + 1}`, isPrimary ? native.workflowId : recoveryNative.workflowId)
    runs.set(run.runId, run)
    if (isPrimary && options.executeWorker) {
      const context = args[0] as Parameters<typeof runAgentWorkflowDefinition>[1]
      await runAgentWorkflowDefinition(agent, { ...context, id: run.runId, name, provider: "vercel" }, (definition, workerRuntime, input) => {
        expect(workerRuntime.run?.runId).toBe(run.runId)
        return runAgentInline(definition, workerRuntime, input)
      })
    }
    if (isPrimary && options.rejectAcknowledgement) throw new Error("SDK acknowledgement lost after acceptance")
    return run
  })
  const getRun = vi.fn((id: string) => runs.get(id) || makeRun(id, native.workflowId, false))
  setVercelWorkflowRuntimeLoader(async () => {
    if (options.failRuntimeLoad) throw new Error("Native SDK unavailable before submission")
    return { start, getRun, listSteps: async () => [], resumeHook: async () => ({ runId: "unused" }) }
  })
  setWorkflowRuntimeConfig({ provider: "vercel" })
  setWorkflowRuntimeRegistry({
    [name]: async () => ({ default: { handler: native, options: { native } } }),
    [getAgentInvocationRecoveryWorkflowName(name)]: async () => ({ default: { internalAgentInvocationRecovery: true, handler: recoveryNative, options: { native: recoveryNative } } }),
  })
  setAgentWorkflowRuntimeLoaders({ state: () => import("../../workflow/src/runtime/state.ts"), workflow: () => import("../../workflow/src/index.ts") })
  const primaryStarts = () => vi.mocked(start).mock.calls.filter(([handler]) => handler === native)
  return { agent, cancel, driver, getRun, invocations, memory, name, primaryStarts, runs, runtime, start, store, allowConfirmation: () => { failConfirmation = false } }
}

it("uses provider IDs with the real native Vercel adapter and omits caller IDs for primary and recovery starts", async () => {
  const test = fixture()
  await expect(createWorkflow(test.name).run({}, { id: "logical-id" })).rejects.toMatchObject({ code: "WORKFLOW_RUN_ID_UNSUPPORTED" })
  expect(test.start).not.toHaveBeenCalled()
  expect(await replayChannel(test.agent, "mailbox", { runtime: test.runtime })).toMatchObject({ processed: 1, failed: 0 })
  expect(test.primaryStarts()).toHaveLength(1)
  expect(test.start).toHaveBeenCalledTimes(2)
  expect(await test.invocations.getByRunId(channelReplayRunId("mailbox", "m1"), test.name)).toMatchObject({
    workflow: { name: test.name, provider: "vercel", id: "wrun_1" }, annotations: { [pendingAgentInvocationAnnotation]: false },
  })
})

it("recovers failed dispatch confirmation by physical provider ID without a second primary start", async () => {
  const test = fixture({ failConfirmation: true })
  vi.useFakeTimers()
  expect(await replayChannel(test.agent, "mailbox", { runtime: test.runtime })).toMatchObject({ processed: 1 })
  expect(await test.invocations.getByRunId(channelReplayRunId("mailbox", "m1"), test.name)).toMatchObject({ workflow: { id: "wrun_1" }, annotations: { [pendingAgentInvocationAnnotation]: true } })
  await vi.advanceTimersByTimeAsync(30_001)
  test.allowConfirmation()
  expect(await replayChannel(test.agent, "mailbox", { runtime: test.runtime })).toMatchObject({ skipped: 1, failed: 0 })
  expect(test.getRun).toHaveBeenCalledWith("wrun_1")
  expect(test.getRun).not.toHaveBeenCalledWith(channelReplayRunId("mailbox", "m1"))
  expect(test.primaryStarts()).toHaveLength(1)
})

it("blocks duplicate submission when native SDK acceptance loses its acknowledgement", async () => {
  const test = fixture({ rejectAcknowledgement: true })
  vi.useFakeTimers()
  expect(await replayChannel(test.agent, "mailbox", { runtime: test.runtime })).toMatchObject({ failed: 1 })
  expect(await test.invocations.getByRunId(channelReplayRunId("mailbox", "m1"), test.name)).toMatchObject({ workflow: { name: test.name, provider: "vercel" }, annotations: { [pendingAgentInvocationAnnotation]: true } })
  await vi.advanceTimersByTimeAsync(30_001)
  expect(await replayChannel(test.agent, "mailbox", { runtime: test.runtime })).toMatchObject({ failed: 1 })
  expect(test.primaryStarts()).toHaveLength(1)
  expect(test.getRun).not.toHaveBeenCalled()
})

it("keeps worker acknowledgement on the logical journal when the worker owns the claim before submitter acknowledgement", async () => {
  const test = fixture({ executeWorker: true })
  expect(await replayChannel(test.agent, "mailbox", { runtime: test.runtime })).toMatchObject({ processed: 1, failed: 0 })
  expect(test.driver).toHaveBeenCalledOnce()
  expect(await test.invocations.getByRunId(channelReplayRunId("mailbox", "m1"), test.name)).toMatchObject({ status: "completed", workflow: { id: "wrun_1" } })
  expect(await test.invocations.getByRunId("wrun_1", test.name)).toBeUndefined()
})


it("fails before SDK submission if dispatch intent cannot be persisted", async () => {
  const test = fixture({ failIntent: true })
  expect(await replayChannel(test.agent, "mailbox", { runtime: test.runtime })).toMatchObject({ failed: 1, processed: 0 })
  expect(test.start).not.toHaveBeenCalled()
  expect(test.driver).not.toHaveBeenCalled()
})

it("cancels the physical provider run and reconciles the logical journal through native recovery", async () => {
  const test = fixture()
  expect(await replayChannel(test.agent, "mailbox", { runtime: test.runtime })).toMatchObject({ processed: 1 })
  await createWorkflow(test.name).cancel("wrun_1")
  expect(test.cancel).toHaveBeenCalledWith("wrun_1")
  const recoveryContext = vi.mocked(test.start).mock.calls[1]![1][0] as Parameters<typeof runAgentWorkflowDefinition>[1]
  await runAgentWorkflowDefinition(test.agent, { ...recoveryContext, id: "wrun_2", provider: "vercel" }, (definition, runtime, input) => runAgentInline(definition, runtime, input))
  expect(test.getRun).toHaveBeenCalledWith("wrun_1")
  expect(await test.invocations.getByRunId(channelReplayRunId("mailbox", "m1"), test.name)).toMatchObject({ status: "cancelled", workflow: { id: "wrun_1" } })
  expect(test.driver).not.toHaveBeenCalled()
})


it("records a definitive failure when the native SDK cannot load before dispatch", async () => {
  const test = fixture({ failRuntimeLoad: true })
  expect(await replayChannel(test.agent, "mailbox", { runtime: test.runtime })).toMatchObject({ failed: 1 })
  expect(test.start).not.toHaveBeenCalled()
  expect(await test.invocations.getByRunId(channelReplayRunId("mailbox", "m1"), test.name)).toMatchObject({ status: "failed" })
})

it("starts independent forced native replays with fresh logical IDs and provider-assigned physical IDs", async () => {
  const test = fixture({ executeWorker: true })
  expect(await replayChannel(test.agent, "mailbox", { runtime: test.runtime })).toMatchObject({ processed: 1 })
  const first = await replayChannel(test.agent, "mailbox", { force: true, runtime: test.runtime })
  const second = await replayChannel(test.agent, "mailbox", { force: true, runtime: test.runtime })
  expect(first).toMatchObject({ processed: 1, failed: 0 })
  expect(second).toMatchObject({ processed: 1, failed: 0 })
  const firstId = first.items[0]!.id
  const secondId = second.items[0]!.id
  expect(firstId).not.toBe(channelReplayRunId("mailbox", "m1"))
  expect(firstId).not.toBe(secondId)
  const firstJournal = await test.invocations.getByRunId(firstId, test.name)
  const secondJournal = await test.invocations.getByRunId(secondId, test.name)
  expect(firstJournal).toMatchObject({ status: "completed", workflow: { provider: "vercel", id: expect.stringMatching(/^wrun_/) } })
  expect(secondJournal).toMatchObject({ status: "completed", workflow: { provider: "vercel", id: expect.stringMatching(/^wrun_/) } })
  expect(firstJournal?.workflow?.id).not.toBe(secondJournal?.workflow?.id)
  expect(test.driver).toHaveBeenCalledTimes(3)
})


it.each([false, true])("keeps discovery-default replay out of inline execution after native acceptance, lost acknowledgement=%s", async rejectAcknowledgement => {
  const test = fixture({ discoveryDefault: true, failConfirmation: true, rejectAcknowledgement })
  vi.useFakeTimers()
  expect(await replayChannel(test.agent, "mailbox", { runtime: test.runtime })).toMatchObject(rejectAcknowledgement ? { failed: 1 } : { processed: 1 })
  await vi.advanceTimersByTimeAsync(30_001)
  test.allowConfirmation()
  const { agentIdentity: _identity, ...runtime } = test.runtime
  expect(await replayChannel(test.agent, "mailbox", { runtime })).toMatchObject({ skipped: 1, failed: 0, processed: 0 })
  expect(test.driver).not.toHaveBeenCalled()
  expect(test.primaryStarts()).toHaveLength(1)
  const worker = test.primaryStarts()[0]![1][0] as Parameters<typeof runAgentWorkflowDefinition>[1]
  await runAgentWorkflowDefinition(test.agent, { ...worker, id: "wrun_1", name: test.name, provider: "vercel" }, (definition, workerRuntime, input) => runAgentInline(definition, workerRuntime, input))
  expect(test.driver).toHaveBeenCalledOnce()
  expect(await test.invocations.getByRunId(channelReplayRunId("mailbox", "m1"), test.name)).toMatchObject({ status: "completed" })
})

it.each(["default", "false"])("executes a fresh %s runtime replay inline without a discovered identity", async mode => {
  const test = fixture({ discoveryDefault: mode === "default", inline: mode === "false" })
  const { agentIdentity: _identity, ...runtime } = test.runtime
  expect(await replayChannel(test.agent, "mailbox", { runtime })).toMatchObject({ processed: 1, failed: 0 })
  expect(test.driver).toHaveBeenCalledOnce()
  expect(test.start).not.toHaveBeenCalled()
})


it("releases the replay claim when reading discovery-default dispatch intent fails", async () => {
  const test = fixture({ discoveryDefault: true, failConfirmation: true })
  vi.useFakeTimers()
  expect(await replayChannel(test.agent, "mailbox", { runtime: test.runtime })).toMatchObject({ processed: 1 })
  await vi.advanceTimersByTimeAsync(30_001)
  const read = test.invocations.getByRunId.bind(test.invocations)
  vi.spyOn(test.invocations, "getByRunId").mockImplementationOnce(read).mockRejectedValueOnce(new Error("Dispatch read unavailable"))
  const release = vi.spyOn(test.store, "release")
  const { agentIdentity: _identity, ...runtime } = test.runtime
  expect(await replayChannel(test.agent, "mailbox", { runtime })).toMatchObject({ failed: 1, processed: 0 })
  expect(release).toHaveBeenCalledOnce()
  expect(test.driver).not.toHaveBeenCalled()
  expect(test.primaryStarts()).toHaveLength(1)
})


it("does not execute an existing native dispatch inline after runtime is explicitly disabled", async () => {
  const test = fixture({ failConfirmation: true })
  vi.useFakeTimers()
  expect(await replayChannel(test.agent, "mailbox", { runtime: test.runtime })).toMatchObject({ processed: 1 })
  await vi.advanceTimersByTimeAsync(30_001)
  const inline = defineAgent({ channels: test.agent.channels, driver: { run: test.driver }, invocations: test.invocations, name: test.name, runtime: false })
  expect(await replayChannel(inline, "mailbox", { runtime: test.runtime })).toMatchObject({ skipped: 1, failed: 0, processed: 0 })
  expect(test.driver).not.toHaveBeenCalled()
  expect(test.primaryStarts()).toHaveLength(1)
})


it("skips metadata-less pending discovery-default reservations without Agent identity", async () => {
  const test = fixture({ discoveryDefault: true })
  vi.useFakeTimers()
  const id = channelReplayRunId("mailbox", "m1")
  const reservation = await bindAgentInvocations(test.invocations, { ...test.runtime, run: { runId: id, annotations: { [pendingAgentInvocationAnnotation]: true } } }, { agentName: test.name, recoverPending: true })
  expect(await reservation?.handoffClaim()).toBeTypeOf("string")
  await vi.advanceTimersByTimeAsync(30_001)
  expect(await test.invocations.getByRunId(id, test.name)).toMatchObject({ status: "pending" })
  expect((await test.invocations.getByRunId(id, test.name))?.workflow).toBeUndefined()
  const { agentIdentity: _identity, ...runtime } = test.runtime
  expect(await replayChannel(test.agent, "mailbox", { runtime })).toMatchObject({ processed: 0, skipped: 1, failed: 0 })
  expect(test.driver).not.toHaveBeenCalled()
  expect(test.start).not.toHaveBeenCalled()
  expect(test.getRun).not.toHaveBeenCalled()
})
