import { afterEach, describe, expect, it, vi } from "vitest"
import * as v from "valibot"

import { defineCollection } from "../../source/src/index.ts"
import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { agentInvocationId, defineAgent, runAgent, runAgentInline } from "../src/index.ts"
import { bindAgentInvocations, pendingAgentInvocationAnnotation } from "../src/invocations.ts"
import { runAgentWorkflowDefinition } from "../src/runtime/workflow.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations, replayChannel } from "../src/server.ts"
import type { AgentInvocationStore } from "../src/server.ts"
import type { AgentRunContext } from "../src/types.ts"

const runtime = (runId: string, waitUntil: (promise: Promise<unknown>) => void = () => {}) => ({ memo: vi.fn(), run: { runId }, runtime: "unknown" as const, waitUntil })

/** Fails the first `running` write. A `timeout` write lands after the one-second store bound, as a slow remote database does. */
function failingRunningStore(failure: "missing" | "rejected" | "timeout") {
  const backing = createMemoryAgentInvocationStore()
  let failed = false
  const store: AgentInvocationStore = {
    ...backing,
    async update(id, input, claimId) {
      if (input.status === "running" && !failed) {
        failed = true
        if (failure === "rejected") throw new Error("Running state unavailable")
        if (failure === "missing") return undefined
        await new Promise(resolve => setTimeout(resolve, 1_200))
      }
      return await backing.update(id, input, claimId)
    },
  }
  return { backing, store }
}

function journalWarnings(calls: readonly unknown[][]) {
  return calls.filter(([message]) => String(message).includes("continues without a confirmed"))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Agent Invocation enforcement", () => {
  it("rejects an unknown enforcement value", () => {
    // SAFETY: The test passes an invalid runtime value through the typed option.
    expect(() => defineAgentInvocations({ enforcement: "loose" as never, store: createMemoryAgentInvocationStore() }))
      .toThrow(expect.objectContaining({ code: "AGENT_R0624" }))
  })

  it.each(["timeout", "rejected", "missing"] as const)("runs a best-effort Invocation when the running write is %s, and the record converges", async (failure) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { store } = failingRunningStore(failure)
    const invocations = defineAgentInvocations({ store })
    const run = vi.fn(() => "done")
    const recovery: Promise<unknown>[] = []
    const runId = `best-effort-running-${failure}`

    await expect(runAgent(defineAgent({ driver: { run }, invocations, runtime: false }), runtime(runId, promise => recovery.push(promise)), {})).resolves.toBe("done")
    expect(run).toHaveBeenCalledOnce()
    await Promise.all(recovery)
    await vi.waitFor(async () => {
      await expect(invocations.getByRunId(runId)).resolves.toMatchObject({ startedAt: expect.any(String), status: "completed" })
    })
    expect(journalWarnings(warn.mock.calls)).toHaveLength(1)
    expect(String(journalWarnings(warn.mock.calls)[0]?.[0])).toContain("running state")
  }, 10_000)

  it("runs a best-effort Invocation with Driver capacity when the running write is missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { store } = failingRunningStore("missing")
    const invocations = defineAgentInvocations({ store })
    const run = vi.fn(() => "done")
    const recovery: Promise<unknown>[] = []

    await expect(runAgent(defineAgent({ driver: { capacity: { concurrency: 1 }, run }, invocations, runtime: false }), runtime("best-effort-capacity", promise => recovery.push(promise)), {})).resolves.toBe("done")
    expect(run).toHaveBeenCalledOnce()
    await Promise.all(recovery)
    await expect(invocations.getByRunId("best-effort-capacity")).resolves.toMatchObject({ startedAt: expect.any(String), status: "completed" })
  })

  it("keeps the strict running-state failure when strict is selected", async () => {
    const { store } = failingRunningStore("missing")
    const invocations = defineAgentInvocations({ enforcement: "strict", store })
    const run = vi.fn(() => "done")

    await expect(runAgent(defineAgent({ driver: { run }, invocations, runtime: false }), runtime("strict-running"), {}))
      .rejects.toThrow("Could not persist the Invocation running state.")
    expect(run).not.toHaveBeenCalled()
  })

  it("logs one warning when the store answers no startup read or write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const failure = new Error("journal unavailable")
    const store: AgentInvocationStore = {
      claim: () => { throw failure },
      create: () => { throw failure },
      get: () => { throw failure },
      getSummary: () => { throw failure },
      getClaimToken: () => { throw failure },
      list: () => { throw failure },
      release: () => { throw failure },
      update: () => { throw failure },
    }
    const run = vi.fn(() => "done")

    await expect(runAgent(defineAgent({ driver: { run }, invocations: defineAgentInvocations({ store }), runtime: false }), runtime("unavailable-store"), {})).resolves.toBe("done")
    expect(run).toHaveBeenCalledOnce()
    expect(journalWarnings(warn.mock.calls)).toHaveLength(1)
    expect(String(journalWarnings(warn.mock.calls)[0]?.[0])).toContain("cancellation check")
  })

  it("stops a best-effort run when another owner holds the claim", async () => {
    const store = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({ store })
    const owner = await bindAgentInvocations(invocations, runtime("claimed-elsewhere"))
    expect(owner?.claimStatus).toBe("owned")
    const run = vi.fn(() => "done")

    await expect(runAgent(defineAgent({ driver: { run }, invocations, runtime: false }), runtime("claimed-elsewhere"), {}))
      .rejects.toThrow("Could not persist the Invocation running state.")
    expect(run).not.toHaveBeenCalled()
    await owner?.finish("completed")
  })

  it("cancels a best-effort run when the store returns a cancellation request after an unconfirmed running write", async () => {
    const backing = createMemoryAgentInvocationStore()
    let runningAttempted = false
    const store: AgentInvocationStore = {
      ...backing,
      async getSummary(id) {
        if (!runningAttempted) throw new Error("Summary unavailable")
        return await backing.getSummary(id)
      },
      async update(id, input, claimId) {
        if (input.status === "running" && !runningAttempted) {
          runningAttempted = true
          const timestamp = new Date().toISOString()
          await backing.update(id, { cancelRequestedAt: timestamp, timestamp })
          return undefined
        }
        return await backing.update(id, input, claimId)
      },
    }
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const invocations = defineAgentInvocations({ store })
    const run = vi.fn(() => "Must not start")

    await expect(runAgent(defineAgent({ driver: { run }, invocations, runtime: false }), runtime("cancel-after-unconfirmed"), {})).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
    expect(await backing.getSummary(await agentInvocationId("cancel-after-unconfirmed"))).toMatchObject({ status: "cancelled" })
  })

  it("cancels an active best-effort run when its retried claim is lost", async () => {
    const backing = createMemoryAgentInvocationStore()
    let runningAttempted = false
    let dispatched = false
    const store: AgentInvocationStore = {
      ...backing,
      async claim(...args) {
        // The revalidation before dispatch must succeed; lose the claim only
        // on the later renewal while the Driver is active.
        // Initial claim, running-state renewal, and pre-dispatch revalidation
        // must all succeed so the loss is observed only after dispatch.
        if (dispatched) return false
        return await backing.claim(...args)
      },
      async update(id, input, claimId) {
        if (input.status === "running" && !runningAttempted) {
          runningAttempted = true
          return undefined
        }
        return await backing.update(id, input, claimId)
      },
    }
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const invocations = defineAgentInvocations({ store })
    const run = vi.fn(async (context: AgentRunContext) => {
      dispatched = true
      const abortSignal = context.input.abortSignal
      await new Promise<void>((resolve, reject) => {
        abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true })
      })
    })

    await expect(runAgent(defineAgent({ driver: { run }, invocations, runtime: false }), runtime("claim-lost-after-dispatch"), {})).rejects.toThrow()
    expect(run).toHaveBeenCalledOnce()
  }, 10_000)

  it("keeps channel replay strict when the running write is not confirmed", async () => {
    const { store } = failingRunningStore("missing")
    const invocations = defineAgentInvocations({ store })
    const run = vi.fn(() => "Must not start")
    const channel = defineChannel("mailbox", {
      history: {
        collection: defineCollection(async () => [{ id: "m1" }], { cursor: item => item.id, cursorSchema: v.string() }),
        key: item => item.id,
      },
      triggers: {
        received: defineChannelTrigger({
          input: v.object({ id: v.string() }),
          invoke: () => ({ input: { prompt: "hello" } }),
        }),
      },
    })
    const agent = defineAgent({ channels: { mailbox: channel }, driver: { run }, invocations, runtime: false })

    const result = await replayChannel(agent, "mailbox", { runtime: { memo: vi.fn(), runtime: "unknown", waitUntil: () => {} } })
    expect(result).toMatchObject({ failed: 1, processed: 0 })
    // A custom `run` Driver fails at its strict cancellation-warning check before the running-state check.
    expect(result.items[0]).toMatchObject({ error: expect.stringMatching(/could not be persisted|Could not persist/), status: "failed" })
    expect(run).not.toHaveBeenCalled()
  })

  it("runs a best-effort Invocation in a Workflow worker without a claim handoff", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { store } = failingRunningStore("timeout")
    const invocations = defineAgentInvocations({ store })
    const run = vi.fn(() => "done")
    const agent = defineAgent({ driver: { run }, invocations, name: "workflow-worker", runtime: false })
    const context = { id: "workflow-worker-run", name: "workflow-worker", payload: { input: { prompt: "hello" } }, provider: "openworkflow" as const }

    await expect(runAgentWorkflowDefinition(agent, context, runAgentInline)).resolves.toBe("done")
    expect(run).toHaveBeenCalledOnce()
    await vi.waitFor(async () => {
      await expect(invocations.getByRunId("workflow-worker-run", "workflow-worker")).resolves.toMatchObject({ startedAt: expect.any(String), status: "completed" })
    })
  }, 10_000)

  it("keeps a Workflow worker strict when it inherits a replay claim", async () => {
    const { store } = failingRunningStore("missing")
    const invocations = defineAgentInvocations({ store })
    const run = vi.fn(() => "Must not start")
    const agent = defineAgent({ driver: { run }, invocations, name: "handoff-worker", runtime: false })
    const reservation = await bindAgentInvocations(invocations, { ...runtime("handoff-worker-run"), run: { runId: "handoff-worker-run", annotations: { [pendingAgentInvocationAnnotation]: true } } }, { agentName: "handoff-worker", recoverPending: true })
    const token = await reservation?.handoffClaim()
    expect(token).toEqual(expect.any(String))
    const context = { id: "handoff-worker-run", name: "handoff-worker", payload: { input: { prompt: "hello" }, invocationClaimToken: token }, provider: "openworkflow" as const }

    await expect(runAgentWorkflowDefinition(agent, context, runAgentInline)).rejects.toThrow(/could not be persisted|Could not persist/)
    expect(run).not.toHaveBeenCalled()
  })
})
