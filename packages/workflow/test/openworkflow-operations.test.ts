import { afterEach, beforeEach, expect, it } from "vitest"

import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"

import { defineWorkflow } from "../src/definition.ts"
import { workflowOperations } from "../src/operations.ts"
import { startWorkflow } from "../src/runtime/client.ts"
import { resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"
import { unwrap } from "./unwrap.ts"

const registry = createOperationRegistry([{ operations: workflowOperations }])

async function call(name: string, input: unknown) {
  return await runOperation(registry, name, input, { access: { mode: "local", sections: "all" }, surface: "cli", user: null })
}

beforeEach(() => {
  resetWorkflowRuntime()
  setWorkflowRuntimeConfig({ driver: "openworkflow", sqlite: { path: ":memory:" } })
  setWorkflowRuntimeRegistry({
    checkout: async () => ({
      default: defineWorkflow<{ order: number }>({ handler: async ({ payload }) => ({ order: payload.order }) }),
    }),
    refund: async () => ({ default: defineWorkflow({ handler: async () => "refunded" }) }),
  })
})

afterEach(async () => {
  await resetOpenWorkflowRuntime()
})

it("lists the runs that OpenWorkflow stores, newest first", async () => {
  const first = await unwrap(startWorkflow("checkout", { order: 1 }))
  const worker = await createOpenWorkflowWorker()
  await worker.tick()
  await worker.stop()
  const second = await unwrap(startWorkflow("refund", undefined, { id: "refund-2" }))

  expect(await call("workflow.runs-list", {})).toMatchObject({ ok: true, value: { runs: [
    { id: second.id, provider: "openworkflow", status: "queued", stepCount: 0, workflow: "refund" },
    { id: first.id, provider: "openworkflow", result: { order: 1 }, status: "completed", stepCount: 1, workflow: "checkout" },
  ] } })
  expect(await call("workflow.runs-list", { status: "completed" })).toMatchObject({ ok: true, value: { runs: [{ id: first.id }] } })
  expect(await call("workflow.runs-list", { workflow: "refund" })).toMatchObject({ ok: true, value: { runs: [{ id: "refund-2" }] } })
  expect(await call("workflow.runs-list", { limit: 1 })).toMatchObject({ ok: true, value: { runs: [{ id: "refund-2" }] } })
})

it("reads a stored run without the Workflow name", async () => {
  const started = await unwrap(startWorkflow("checkout", { order: 7 }))
  await unwrap(startWorkflow("refund", undefined, { id: "refund-7" }))

  expect(await call("workflow.get", { runId: started.id })).toMatchObject({ ok: true, value: { run: { id: started.id, status: "queued", workflow: "checkout" } } })
  expect(await call("workflow.get", { runId: "refund-7" })).toMatchObject({ ok: true, value: { run: { id: "refund-7", workflow: "refund" } } })
  expect(await call("workflow.get", { runId: "missing" })).toMatchObject({ code: "WORKFLOW_RUN_UNKNOWN", ok: false, status: 400 })
})

it("asks for the Workflow name when two Workflows use the same id", async () => {
  await unwrap(startWorkflow("checkout", { order: 9 }, { id: "shared-9" }))
  await unwrap(startWorkflow("refund", undefined, { id: "shared-9" }))

  expect(await call("workflow.get", { runId: "shared-9" })).toMatchObject({ code: "WORKFLOW_RUN_AMBIGUOUS", ok: false, status: 400 })
  expect(await call("workflow.get", { runId: "shared-9", workflow: "refund" })).toMatchObject({ ok: true, value: { run: { id: "shared-9", workflow: "refund" } } })
})
