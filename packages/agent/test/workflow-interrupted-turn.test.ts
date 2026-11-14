import { AsyncLocalStorage } from "node:async_hooks"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runAgentInline } from "../src/internal/agent-run.ts"
import { defineAgent } from "../src/index.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"
import { runAgentWorkflowDefinition } from "../src/runtime/workflow.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import type { AgentInvocationStore } from "../src/server.ts"

// The journal asks for 30 second leases. The test store shortens them, so a lease expires without a fake clock.
const leaseMs = 300
const never = new Promise<never>(() => {})
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

const stores: Array<[string, () => Promise<AgentInvocationStore>]> = [
  ["memory store", async () => createMemoryAgentInvocationStore()],
  ["SQLite store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-interrupted-turn-"))
    directories.push(directory)
    return createLibsqlAgentInvocationStore({ maxAge: false, maxRecords: false, url: `file:${join(directory, "journal.sqlite")}` })
  }],
]

/**
 * After `stop()`, store calls from the first attempt get no answer, as when its process exits.
 * With `failFirstRunningWrite`, the store does not write the `running` state for the first attempt.
 */
function interruptibleStore(backing: AgentInvocationStore, { failFirstRunningWrite = false } = {}) {
  const firstAttempt = new AsyncLocalStorage<true>()
  let stopped = false
  const frozen = () => stopped && firstAttempt.getStore() === true
  const store: AgentInvocationStore = {
    ...backing,
    claim: (id, claimId, _leaseMs, options) => frozen() ? never : backing.claim(id, claimId, leaseMs, options),
    get: (...args) => frozen() ? never : backing.get(...args),
    getSummary: id => frozen() ? never : backing.getSummary(id),
    release: (...args) => frozen() ? never : backing.release(...args),
    update: (id, input, claimId) => {
      if (frozen()) return never
      if (failFirstRunningWrite && input.status === "running" && firstAttempt.getStore() === true) return undefined
      return backing.update(id, input, claimId)
    },
  }
  return {
    store,
    runFirstAttempt: <T>(attempt: () => T) => firstAttempt.run(true, attempt),
    stop: () => { stopped = true },
  }
}

describe.each(stores)("Workflow retry of an interrupted Agent turn (%s)", (_name, createStore) => {
  async function interruptTurn() {
    const { store, runFirstAttempt, stop } = interruptibleStore(await createStore())
    const invocations = defineAgentInvocations({ store })
    let driverStarted: () => void = () => {}
    const firstDriver = new Promise<void>(resolve => { driverStarted = resolve })
    const run = vi.fn(async () => "The Driver ran again.")
    run.mockImplementationOnce(async () => {
      driverStarted()
      return await never
    })
    const agent = defineAgent({ driver: { run }, invocations, name: "interrupted-turn", runtime: false })
    const attempt = { id: "interrupted-turn-run", name: "interrupted-turn", payload: { input: { prompt: "hello" } }, provider: "openworkflow" as const }

    void runFirstAttempt(() => runAgentWorkflowDefinition(agent, attempt, runAgentInline))
    await firstDriver
    stop()
    await expect(invocations.getByRunId(attempt.id, "interrupted-turn")).resolves.toMatchObject({ status: "running" })
    return { agent, attempt, invocations, run }
  }

  const interrupted = { code: "AGENT_INVOCATION_DRIVER_INTERRUPTED", isRetryable: false }

  it("does not run the Driver again after the claim of the stopped attempt expired", async () => {
    const { agent, attempt, invocations, run } = await interruptTurn()
    // The provider retries the run after its own lease, when the journal claim has expired too.
    await new Promise(resolve => setTimeout(resolve, leaseMs * 2))

    await expect(runAgentWorkflowDefinition(agent, attempt, runAgentInline)).rejects.toMatchObject(interrupted)
    expect(run).toHaveBeenCalledOnce()
    await expect(invocations.getByRunId(attempt.id, "interrupted-turn")).resolves.toMatchObject({
      error: expect.objectContaining({ code: "AGENT_INVOCATION_DRIVER_INTERRUPTED" }),
      status: "failed",
    })
  })

  it("fails with the same error while the stopped attempt still holds its claim", async () => {
    const { agent, attempt, invocations, run } = await interruptTurn()

    // The retry writes the failed state when the claim of the stopped attempt expires.
    await expect(runAgentWorkflowDefinition(agent, attempt, runAgentInline)).rejects.toMatchObject(interrupted)
    expect(run).toHaveBeenCalledOnce()
    await expect(invocations.getByRunId(attempt.id, "interrupted-turn")).resolves.toMatchObject({
      error: expect.objectContaining({ code: "AGENT_INVOCATION_DRIVER_INTERRUPTED" }),
      status: "failed",
    })
  })

  it("does not start the Driver when the running state was not written, so a retry runs it once", async () => {
    const { store, runFirstAttempt, stop } = interruptibleStore(await createStore(), { failFirstRunningWrite: true })
    const invocations = defineAgentInvocations({ store })
    let driverStarted: () => void = () => {}
    const firstDriver = new Promise<"driver started">(resolve => { driverStarted = () => resolve("driver started") })
    let firstAttemptEnded = false
    // A Driver of the first attempt never returns, as when its process stops during the Driver.
    const run = vi.fn(async () => {
      if (firstAttemptEnded) return "The retry ran the Driver."
      driverStarted()
      return await never
    })
    const agent = defineAgent({ driver: { run }, invocations, name: "interrupted-turn", runtime: false })
    const attempt = { id: "running-write-failed-run", name: "interrupted-turn", payload: { input: { prompt: "hello" } }, provider: "openworkflow" as const }

    const first = runFirstAttempt(() => runAgentWorkflowDefinition(agent, attempt, runAgentInline))
    const outcome = await Promise.race([first.then(() => "completed", () => "failed"), firstDriver])
    firstAttemptEnded = true
    // The record is still pending, so a Driver started here would run again on the retry.
    expect(outcome).toBe("failed")
    expect(run).not.toHaveBeenCalled()
    // The failed attempt is not the outcome of the turn: the Workflow retries it.
    await expect(invocations.getByRunId(attempt.id, "interrupted-turn")).resolves.toMatchObject({ status: "pending" })
    stop()

    await runAgentWorkflowDefinition(agent, attempt, runAgentInline)
    expect(run).toHaveBeenCalledOnce()
    await expect(invocations.getByRunId(attempt.id, "interrupted-turn")).resolves.toMatchObject({ status: "completed" })
  })
})
