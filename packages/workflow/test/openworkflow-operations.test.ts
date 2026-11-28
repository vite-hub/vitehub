import { randomUUID } from "node:crypto"

import postgres from "postgres"
import { afterEach, beforeEach, expect, it } from "vitest"

import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"

import { defineWorkflow } from "../src/definition.ts"
import { workflowOperations } from "../src/operations.ts"
import { startWorkflow } from "../src/runtime/client.ts"
import { enableWorkflowDevRuns } from "../src/runtime/dev-runs.ts"
import { resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { registerInlineWorkflowDefinition, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"
import { unwrap } from "./unwrap.ts"

const registry = createOperationRegistry([{ operations: workflowOperations }])
const postgresUrl = process.env.VITEHUB_TEST_POSTGRES_URL

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

it("resolves inline and stored runs together before reading or cancelling", async () => {
  enableWorkflowDevRuns()
  registerInlineWorkflowDefinition("receipt", defineWorkflow({ handler: async () => "sent" }))
  await unwrap(startWorkflow("receipt", undefined, { id: "order-42" }))
  await unwrap(startWorkflow("checkout", { order: 42 }, { id: "order-42" }))

  for (const operation of ["workflow.get", "workflow.cancel"]) {
    expect(await call(operation, { runId: "order-42" })).toMatchObject({ code: "WORKFLOW_RUN_AMBIGUOUS", ok: false })
  }
  expect(await call("workflow.get", { runId: "order-42", workflow: "receipt" })).toMatchObject({ ok: true, value: { run: { workflow: "receipt", steps: expect.any(Array) } } })
  expect(await call("workflow.cancel", { runId: "order-42", workflow: "receipt" })).toMatchObject({ code: "WORKFLOW_OPERATION_UNSUPPORTED", ok: false })
  expect(await call("workflow.get", { runId: "order-42", workflow: "checkout" })).toMatchObject({ ok: true, value: { run: { status: "queued" } } })
  expect(await call("workflow.cancel", { runId: "order-42", workflow: "checkout" })).toMatchObject({ ok: true, value: { run: { status: "cancelled" } } })
})

it("checks storage even for a run started by the operation", async () => {
  const started = await call("workflow.start", { workflow: "checkout", payload: { order: 42 } })
  if (!started.ok) throw new Error("start failed")
  const { id } = (started.value as { run: { id: string } }).run
  await unwrap(startWorkflow("refund", undefined, { id }))

  for (const operation of ["workflow.get", "workflow.cancel"]) {
    expect(await call(operation, { runId: id })).toMatchObject({ code: "WORKFLOW_RUN_AMBIGUOUS", ok: false })
  }
})

it("reads and cancels retained runs without a current definition", async () => {
  const started = await unwrap(startWorkflow("checkout", { order: 7 }, { id: "order-7" }))
  setWorkflowRuntimeRegistry({})

  expect(await call("workflow.get", { runId: started.id })).toMatchObject({ ok: true, value: { run: { status: "queued", workflow: "checkout" } } })
  expect(await call("workflow.get", { runId: "order-7", workflow: "checkout" })).toMatchObject({ ok: true, value: { run: { status: "queued", workflow: "checkout" } } })
  expect(await call("workflow.cancel", { runId: "order-7" })).toMatchObject({ ok: true, value: { run: { status: "cancelled", workflow: "checkout" } } })
})

it.skipIf(!postgresUrl)("resolves PostgreSQL runs by provider ID and idempotency key", async () => {
  const schema = `vitehub_runs_${randomUUID().replaceAll("-", "")}`
  const sql = postgres(postgresUrl!, { max: 1 })
  setWorkflowRuntimeConfig({ driver: "openworkflow", postgres: { schema, url: postgresUrl! } })
  try {
    const started = await unwrap(startWorkflow("checkout", { order: 7 }))
    await unwrap(startWorkflow("refund", undefined, { id: "refund-7" }))
    setWorkflowRuntimeRegistry({})

    expect(await call("workflow.get", { runId: started.id })).toMatchObject({ ok: true, value: { run: { id: started.id, workflow: "checkout" } } })
    expect(await call("workflow.get", { runId: "refund-7" })).toMatchObject({ ok: true, value: { run: { id: "refund-7", workflow: "refund" } } })
    expect(await call("workflow.cancel", { runId: "refund-7" })).toMatchObject({ ok: true, value: { run: { status: "cancelled", workflow: "refund" } } })
  }
  finally {
    await resetOpenWorkflowRuntime()
    try {
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
    }
    finally {
      await sql.end()
    }
  }
})
