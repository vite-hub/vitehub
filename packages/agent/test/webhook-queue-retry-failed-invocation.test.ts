import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent } from "../src/index.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"
import { agentInvocationId, applyAgentInvocationStoreUpdate, createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

import type { AgentInvocationRecord, AgentInvocationStore } from "../src/server.ts"

const scope = "webhook:review:github:github:"
const runId = "delivery-transient-failure"

const stores: [string, (dir: string) => AgentInvocationStore][] = [
  ["memory", () => createMemoryAgentInvocationStore()],
  ["SQLite", dir => createLibsqlAgentInvocationStore({ url: `file:${join(dir, "invocations.sqlite")}` })],
]

/** One queued webhook delivery whose first attempt fails with a transient error. */
async function setup(store: (dir: string) => AgentInvocationStore, failures = 1) {
  const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-retry-failed-invocation-"))
  const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
  const invocations = defineAgentInvocations({ store: store(stateDir) })
  const run = vi.fn(async () => {
    if (run.mock.calls.length <= failures) throw new Error(`GitHub is unavailable (attempt ${run.mock.calls.length}).`)
    return "done"
  })
  const agent = defineAgent({ driver: { run }, invocations })
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
  // SAFETY: The test Agent supplies the route contract through defineAgent.
  const stop = createChannelWebhookRouteHandler(agent as never).resume({ agentName: "review", webhookState: state })
  return {
    id: await agentInvocationId(runId, "review"),
    invocations,
    run,
    state,
    async cleanup() {
      await stop()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    },
  }
}

const attemptId = (observation: { attributes?: Record<string, unknown> }) => observation.attributes?.["agent.invocation.id"]

describe.each(stores)("queued webhook retry after a failed attempt (%s store)", (_name, store) => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    await cleanup?.()
    cleanup = undefined
    vi.restoreAllMocks()
  })

  it("reopens the failed Invocation and records the retry's outcome", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const fixture = await setup(store)
    cleanup = fixture.cleanup

    await vi.waitFor(async () => expect(await fixture.state.webhookDeliveries(scope)).toEqual([]), { timeout: 10_000 })
    expect(fixture.run).toHaveBeenCalledTimes(2)
    const completed = await fixture.invocations.get(fixture.id)
    expect(completed).toMatchObject({ status: "completed" })
    expect(completed?.error).toBeUndefined()
    expect(completed?.failedAt).toBeUndefined()
    // The record keeps the failed attempt and adds the retry's start and finish.
    const starts = completed?.observations.filter(observation => observation.name === "agent.invocation.start").map(attemptId)
    expect(starts).toHaveLength(2)
    expect(new Set(starts).size).toBe(2)
    expect(completed?.observations.filter(observation => observation.name === "agent.invocation.error")).toEqual([
      expect.objectContaining({ attributes: expect.objectContaining({ "agent.invocation.id": starts?.[0], "error.message": "GitHub is unavailable (attempt 1)." }) }),
    ])
    expect(completed?.observations.filter(observation => observation.name === "agent.invocation.finish").map(attemptId)).toEqual([starts?.[1]])
    expect((await fixture.invocations.list()).invocations).toHaveLength(1)
  })

  it("leaves the Invocation failed with the last error when every attempt fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const fixture = await setup(store, 3)
    cleanup = fixture.cleanup

    // The queue waits 1 s and then 2 s before the retries.
    await vi.waitFor(async () => expect(await fixture.state.webhookDeliveries(scope)).toEqual([]), { timeout: 15_000 })
    expect(fixture.run).toHaveBeenCalledTimes(3)
    const failed = await fixture.invocations.get(fixture.id)
    expect(failed).toMatchObject({ error: { message: "GitHub is unavailable (attempt 3)." }, status: "failed" })
    expect(failed?.observations.filter(observation => observation.name === "agent.invocation.error")).toHaveLength(3)
  }, 20_000)
})

describe("reopening a stored Invocation", () => {
  const record: AgentInvocationRecord = {
    createdAt: "2026-01-01T00:00:00.000Z",
    cursor: "1",
    error: { message: "GitHub is unavailable.", name: "Error" },
    failedAt: "2026-01-01T00:00:01.000Z",
    id: "invocation",
    observations: [],
    status: "failed",
    traceId: "trace",
    updatedAt: "2026-01-01T00:00:01.000Z",
  }
  const reopen = { reopen: true, timestamp: "2026-01-01T00:00:02.000Z" } as const

  it("returns a failed record to pending without its error", () => {
    const reopened = applyAgentInvocationStoreUpdate(record, reopen)
    expect(reopened).toMatchObject({ status: "pending", updatedAt: reopen.timestamp })
    expect(reopened).not.toHaveProperty("error")
    expect(reopened).not.toHaveProperty("failedAt")
  })

  it.each(["completed", "cancelled", "running"] as const)("keeps a %s record", (status) => {
    const stored = { ...record, status }
    expect(applyAgentInvocationStoreUpdate(stored, reopen)).toBe(stored)
  })
})
