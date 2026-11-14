import { afterEach, beforeEach, expect, it } from "vitest"

import { defineWorkflow } from "../src/definition.ts"
import { cancelWorkflow, getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { getOpenWorkflowRuntime, resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

const config = { provider: "openworkflow", sqlite: { path: ":memory:" } } as const
const seenIds: Array<string | undefined> = []

beforeEach(() => {
  resetWorkflowRuntime()
  seenIds.length = 0
  setWorkflowRuntimeConfig(config)
  setWorkflowRuntimeRegistry({
    checkout: async () => ({
      default: defineWorkflow("checkout", async (payload: { order: number }, context) => {
        seenIds.push(context.id)
        return { order: payload.order }
      }),
    }),
  })
})

afterEach(async () => {
  await resetOpenWorkflowRuntime()
})

it("uses the id that the caller passes as the OpenWorkflow run id", async () => {
  const started = await startWorkflow("checkout", { order: 1042 }, { id: "checkout-1042" })
  expect(started.id).toBe("checkout-1042")

  await expect(getWorkflowRun("checkout", "checkout-1042")).resolves.toMatchObject({ id: "checkout-1042", status: "queued" })

  const worker = await createOpenWorkflowWorker()
  await worker.tick()
  await worker.stop()

  expect(seenIds).toEqual(["checkout-1042"])
  await expect(getWorkflowRun("checkout", "checkout-1042")).resolves.toMatchObject({ id: "checkout-1042", status: "completed" })
})

it("cancels a run by the id that the caller passes", async () => {
  await startWorkflow("checkout", { order: 7 }, { id: "checkout-7" })

  await expect(cancelWorkflow("checkout", "checkout-7")).resolves.toMatchObject({ id: "checkout-7", status: "cancelled" })
})

it("returns the stored run for a second start with the same id after the OpenWorkflow idempotency window", async () => {
  const first = await startWorkflow("checkout", { order: 1 }, { id: "checkout-old" })
  const runtime = await getOpenWorkflowRuntime(config)
  const stored = await runtime.backend.listWorkflowRuns({})
  expect(stored.data).toHaveLength(1)
  // Move the run out of the 24 hour OpenWorkflow idempotency window.
  const db: { prepare(sql: string): { run(...values: unknown[]): unknown } } = Reflect.get(runtime.backend, "db")
  db.prepare(`UPDATE "workflow_runs" SET "created_at" = ?`).run(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())

  const second = await startWorkflow("checkout", { order: 2 }, { id: "checkout-old" })

  expect(second.id).toBe(first.id)
  expect((await runtime.backend.listWorkflowRuns({})).data).toHaveLength(1)
})

it("keeps the OpenWorkflow id for runs that start without an id", async () => {
  const started = await startWorkflow("checkout", { order: 3 })

  expect(started.id).toMatch(/^[0-9a-f-]{36}$/)
  await expect(getWorkflowRun("checkout", started.id)).resolves.toMatchObject({ id: started.id, status: "queued" })
})

it("reports unknown for an id of another Workflow", async () => {
  setWorkflowRuntimeRegistry({
    checkout: async () => ({ default: defineWorkflow("checkout", async () => "ok") }),
    refund: async () => ({ default: defineWorkflow("refund", async () => "ok") }),
  })
  await startWorkflow("refund", undefined, { id: "shared-1" })

  await expect(getWorkflowRun("checkout", "shared-1")).resolves.toEqual({ id: "shared-1", provider: "openworkflow", status: "unknown" })
})
