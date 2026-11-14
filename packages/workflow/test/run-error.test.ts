import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { getCloudflareWorkflowBindingName } from "../src/integrations/cloudflare.ts"
import { createWorkflow, getWorkflowRun } from "../src/runtime/client.ts"
import { getOpenWorkflowRun, resetOpenWorkflowRuntime, setOpenWorkflowImporter } from "../src/runtime/openworkflow.ts"
import { toWorkflowRunView } from "../src/runtime/operations.ts"
import { enterWorkflowRuntimeEvent, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"
import { inspectVercelWorkflowRun, setVercelWorkflowRuntimeLoader, setVercelWorkflowRuntimeModules } from "../src/runtime/vercel.ts"

import type { VercelRun } from "../src/runtime/vercel.ts"

beforeEach(async () => {
  resetWorkflowRuntime()
  await resetOpenWorkflowRuntime()
})

afterEach(async () => {
  setVercelWorkflowRuntimeLoader()
  setOpenWorkflowImporter(async specifier => await import(specifier))
  await resetOpenWorkflowRuntime()
})

it("reports the error of a failed inline run", async () => {
  setWorkflowRuntimeConfig({ provider: "vercel" })
  const workflow = createWorkflow("inline-failure", async () => {
    throw Object.assign(new TypeError("card declined"), { code: "CARD_DECLINED" })
  })

  await workflow.start({}, { id: "inline-1" })
  await vi.waitFor(async () => expect((await workflow.getRun("inline-1")).status).toBe("failed"))
  const run = await workflow.getRun("inline-1")

  expect(run.error).toEqual({ code: "CARD_DECLINED", message: "card declined", name: "TypeError" })
  expect(run.metadata).toBeUndefined()
  expect(JSON.parse(JSON.stringify(run.error))).toEqual(run.error)
})

it("reports the error of an errored Cloudflare instance", async () => {
  setWorkflowRuntimeConfig({ provider: "cloudflare" })
  setWorkflowRuntimeRegistry({ checkout: async () => ({ default: { handler: async () => ({ ok: true }) } }) })
  enterWorkflowRuntimeEvent({ req: { runtime: { cloudflare: { env: {
    [getCloudflareWorkflowBindingName("checkout")]: {
      createBatch: vi.fn(),
      get: async (id: string) => ({ id, status: async () => ({ error: { message: "boom", name: "Error" }, output: null, status: "errored" }) }),
    },
  } } } } })

  const run = await getWorkflowRun("checkout", "cf-1")

  expect(run).toMatchObject({ error: { message: "boom" }, status: "failed" })
  expect(run.error).toEqual({ message: "boom" })
  await expect(toWorkflowRunView(run, "checkout")).resolves.toMatchObject({ error: { message: "boom" } })
})

it("reports the error of a failed OpenWorkflow run", async () => {
  const backend = {
    getWorkflowRun: async () => ({
      error: { message: "step failed", name: "RangeError", stack: "RangeError: step failed\n    at x" },
      id: "ow-1",
      namespaceId: "default",
      output: null,
      status: "failed",
      version: null,
      workflowName: "checkout",
    }),
    stop: async () => {},
  }
  setOpenWorkflowImporter(async (specifier) => {
    // SAFETY: The fake modules implement the OpenWorkflow members that this read uses.
    if (specifier === "openworkflow") return { OpenWorkflow: class { constructor() {} } } as never
    // SAFETY: The fake modules implement the OpenWorkflow members that this read uses.
    if (specifier === "openworkflow/sqlite") return { BackendSqlite: { connect: async () => backend } } as never
    // SAFETY: Other modules load as usual.
    return await import(specifier) as never
  })

  const run = await getOpenWorkflowRun({ provider: "openworkflow", sqlite: { path: ":memory:" } }, "checkout", "ow-1")

  expect(run).toMatchObject({ status: "failed" })
  expect(run.error).toEqual({ message: "step failed", name: "RangeError" })
  expect(run.metadata).toEqual({ namespaceId: "default", version: null, workflowName: "checkout" })
})

it("reports the error of a failed native Vercel run", async () => {
  const native = Object.assign(async () => "done", { workflowId: "workflow//checkout" })
  const cause = Object.assign(new Error("payment API returned 503"), { code: "PAYMENT_UNAVAILABLE" })
  const failure = Object.assign(new Error("Workflow run \"run-1\" failed: payment API returned 503"), { cause, errorCode: "USER_ERROR", name: "WorkflowRunFailedError" })
  const returnValue = Promise.reject(failure)
  returnValue.catch(() => {})
  const run: VercelRun = {
    cancel: async () => {},
    completedAt: Promise.resolve(new Date("2026-01-01T00:00:01Z")),
    createdAt: Promise.resolve(new Date("2026-01-01T00:00:00Z")),
    exists: Promise.resolve(true),
    returnValue,
    runId: "run-1",
    startedAt: Promise.resolve(new Date("2026-01-01T00:00:00Z")),
    status: Promise.resolve("failed"),
    workflowName: Promise.resolve(native.workflowId),
  }
  setVercelWorkflowRuntimeModules({
    getRun: () => run,
    resumeHook: async () => ({ runId: run.runId }),
    start: async () => run,
  }, { getWorld: async () => ({ steps: { list: async () => ({ data: [], hasMore: false }) } }) })

  const inspected = await inspectVercelWorkflowRun("checkout", { handler: native, options: { native } }, "run-1")

  expect(inspected).toMatchObject({ status: "failed" })
  expect(inspected.error).toEqual({ code: "PAYMENT_UNAVAILABLE", message: "payment API returned 503" })
})

it("adds no error to a run that did not fail", async () => {
  setWorkflowRuntimeConfig({ provider: "vercel" })
  const workflow = createWorkflow("inline-success", async () => ({ ok: true }))

  await workflow.start({}, { id: "inline-ok" })
  await vi.waitFor(async () => expect((await workflow.getRun("inline-ok")).status).toBe("completed"))

  expect(await workflow.getRun("inline-ok")).not.toHaveProperty("error")
})
