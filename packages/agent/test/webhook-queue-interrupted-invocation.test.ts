import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent } from "../src/index.ts"
import { isRuntimeFunction } from "../src/internal/runtime-value.ts"
import { agentInvocationId, createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

const scope = "webhook:review:github:github:"
const runId = "delivery-interrupted"

type QueueState = ReturnType<typeof createLibsqlAgentState>

/** One queued webhook delivery whose Invocation the first attempt holds until its abort signal fires. */
async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-interrupted-invocation-"))
  const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
  const run = vi.fn(async ({ input }: { input: { abortSignal?: AbortSignal } }) => {
    if (run.mock.calls.length === 1) {
      await new Promise<never>((_resolve, reject) => {
        input.abortSignal?.addEventListener("abort", () => reject(input.abortSignal?.reason), { once: true })
      })
    }
    return "done"
  })
  const agent = defineAgent({ driver: { run }, invocations })
  const id = await agentInvocationId(runId, "review")
  await state.connect()
  await state.enqueueWebhookDelivery({
    concurrencyGroup: "review:default",
    concurrencyLimit: 1,
    deliveryId: runId,
    enqueuedAt: Date.now(),
    invocation: { input: { prompt: "review the pull request" }, run: { runId } },
    leaseTtlMs: 30_000,
    request: { body: "{}", headers: {}, method: "POST", url: "https://example.com/api/github/webhook" },
    scope,
    webhookId: "github",
  })
  const stops: (() => Promise<void>)[] = []
  return {
    id,
    invocations,
    run,
    state,
    /** Starts the queue like a new server process, including its interrupted Invocation recovery. */
    start(webhookState: QueueState = state) {
      // SAFETY: The test Agent supplies the route contract through defineAgent.
      const stop = createChannelWebhookRouteHandler(agent as never).resume({
        agentName: "review",
        recoverInterruptedBefore: Date.now(),
        webhookState,
      })
      stops.push(stop)
      return stop
    },
    async cleanup() {
      await Promise.allSettled(stops.map(stop => stop()))
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    },
  }
}

const attemptId = (observation: { attributes?: Record<string, unknown> }) => observation.attributes?.["agent.invocation.id"]

describe("queued webhook Invocation interrupted by a queue stop", () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    await cleanup?.()
    cleanup = undefined
    vi.restoreAllMocks()
  })

  it("completes the same Invocation when the queue retries the delivery", async () => {
    const fixture = await setup()
    cleanup = fixture.cleanup
    const stopFirstProcess = fixture.start()
    await vi.waitFor(() => expect(fixture.run).toHaveBeenCalledOnce())
    await vi.waitFor(async () => expect(await fixture.invocations.get(fixture.id)).toMatchObject({ status: "running" }))

    // SIGTERM: the queue aborts active work and reschedules the delivery.
    await stopFirstProcess()
    const interrupted = await fixture.invocations.get(fixture.id)
    expect(interrupted?.status).toBe("running")
    expect(await fixture.state.webhookDeliveries(scope)).toEqual([expect.objectContaining({ deliveryId: runId })])

    fixture.start()
    await vi.waitFor(async () => expect(await fixture.invocations.get(fixture.id)).toMatchObject({ status: "completed" }), { timeout: 10_000 })
    expect(fixture.run).toHaveBeenCalledTimes(2)
    const completed = await fixture.invocations.get(fixture.id)
    expect(completed?.error).toBeUndefined()
    // The record keeps the first attempt and adds the second attempt's start and finish.
    const attempts = completed?.observations.filter(observation => observation.name === "agent.invocation.start").map(attemptId)
    expect(attempts).toHaveLength(2)
    expect(new Set(attempts).size).toBe(2)
    expect(completed?.observations.slice(0, interrupted?.observations.length)).toEqual(interrupted?.observations)
    expect(completed?.observations.filter(observation => observation.name === "agent.invocation.finish").map(attemptId)).toEqual([attempts?.[1]])
    expect((await fixture.invocations.list()).invocations).toHaveLength(1)
    await vi.waitFor(async () => expect(await fixture.state.webhookDeliveries(scope)).toEqual([]))
  })

  it("keeps a user cancellation final", async () => {
    const fixture = await setup()
    cleanup = fixture.cleanup
    const stopFirstProcess = fixture.start()
    await vi.waitFor(async () => expect(await fixture.invocations.get(fixture.id)).toMatchObject({ status: "running" }))

    await fixture.invocations.cancel(fixture.id)
    await vi.waitFor(async () => expect(await fixture.invocations.get(fixture.id)).toMatchObject({ status: "cancelled" }))
    await vi.waitFor(async () => expect(await fixture.state.webhookDeliveries(scope)).toEqual([]))
    await stopFirstProcess()

    fixture.start()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(fixture.run).toHaveBeenCalledOnce()
    await expect(fixture.invocations.get(fixture.id)).resolves.toMatchObject({ status: "cancelled" })
  })

  it("does not run an interrupted Invocation again after a user cancels it", async () => {
    const fixture = await setup()
    cleanup = fixture.cleanup
    const stopFirstProcess = fixture.start()
    await vi.waitFor(async () => expect(await fixture.invocations.get(fixture.id)).toMatchObject({ status: "running" }))
    await stopFirstProcess()

    await fixture.invocations.cancel(fixture.id)
    fixture.start()
    await vi.waitFor(async () => expect(await fixture.invocations.get(fixture.id)).toMatchObject({ status: "cancelled" }))
    await vi.waitFor(async () => expect(await fixture.state.webhookDeliveries(scope)).toEqual([]))
    expect(fixture.run).toHaveBeenCalledOnce()
  })

  it("fails an interrupted Invocation when the queue gives up on its delivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const fixture = await setup()
    cleanup = fixture.cleanup
    const stopFirstProcess = fixture.start()
    await vi.waitFor(async () => expect(await fixture.invocations.get(fixture.id)).toMatchObject({ status: "running" }))
    await stopFirstProcess()

    // The next claim finds the delivery out of attempts, so the queue does not run it again.
    const state = fixture.state
    const exhausted = new Proxy(state, {
      get(target, property) {
        if (property === "claimWebhookDelivery") {
          return async (...args: Parameters<QueueState["claimWebhookDelivery"]>) => {
            const lease = await state.claimWebhookDelivery(...args)
            return lease && { ...lease, attempts: 3 }
          }
        }
        const value = Reflect.get(target, property)
        return isRuntimeFunction(value) ? value.bind(target) : value
      },
    })
    fixture.start(exhausted)
    await vi.waitFor(async () => expect(await fixture.invocations.get(fixture.id)).toMatchObject({
      error: { message: expect.stringContaining("exhausted 3 execution leases") },
      status: "failed",
    }))
    await vi.waitFor(async () => expect(await state.webhookDeliveries(scope)).toEqual([]))
    expect(fixture.run).toHaveBeenCalledOnce()
  })
})
