import { afterEach, expect, it } from "vitest"

import { inspectVercelWorkflowRun, setVercelWorkflowRuntimeLoader, setVercelWorkflowRuntimeModules } from "../src/runtime/vercel.ts"
import type { VercelRun } from "../src/runtime/vercel.ts"

const native = Object.assign(async () => "done", { workflowId: "workflow-pagination" })
const definition = { handler: native, options: { native } }

function installStepsList(list: (options: unknown) => Promise<{ cursor?: string | null, data: unknown[], hasMore: boolean }>) {
  const run: VercelRun = {
    cancel: async () => {},
    completedAt: Promise.resolve(undefined),
    createdAt: Promise.resolve(new Date("2026-01-01T00:00:00Z")),
    exists: Promise.resolve(true),
    returnValue: Promise.resolve(undefined),
    runId: "run-pagination",
    startedAt: Promise.resolve(undefined),
    status: Promise.resolve("running"),
    workflowName: Promise.resolve(native.workflowId),
  }
  setVercelWorkflowRuntimeModules({
    getRun: () => run,
    resumeHook: async () => ({ runId: run.runId }),
    start: async () => run,
  }, { getWorld: async () => ({ steps: { list } }) })
}

afterEach(() => setVercelWorkflowRuntimeLoader())

it("reads Vercel step pages through empty pages and ignores a final cursor", async () => {
  const requests: unknown[] = []
  const step = { attempt: 1, status: "completed", stepId: "step-one", stepName: "first" }
  const pages = [
    { cursor: "one", data: [], hasMore: true },
    { cursor: "two", data: [step], hasMore: true },
    { cursor: "two", data: [], hasMore: false },
  ]
  installStepsList(async (options) => {
    requests.push(options)
    const page = pages.shift()
    if (!page) throw new Error("Unexpected extra page request.")
    return page
  })

  const result = await inspectVercelWorkflowRun("pagination", definition, "run-pagination")

  expect(result.steps).toMatchObject([{ id: "step-one", name: "first", status: "completed" }])
  expect(requests).toEqual([undefined, "one", "two"].map(cursor => ({
    pagination: { cursor, limit: 1000, sortOrder: "asc" },
    resolveData: "none",
    runId: "run-pagination",
  })))
})

it.each([
  { cursors: ["one", "one"], name: "a repeated cursor" },
  { cursors: ["one", "two", "one"], name: "a cursor cycle" },
])("rejects $name before requesting the same page again", async ({ cursors }) => {
  let calls = 0
  installStepsList(async () => {
    const cursor = cursors[calls++]
    if (!cursor) throw new Error("Pagination safety stop: the provider page was requested again.")
    return { cursor, data: [], hasMore: true }
  })

  await expect(inspectVercelWorkflowRun("pagination", definition, "run-pagination")).rejects.toMatchObject({
    cause: { code: "WORKFLOW_R0026" },
    code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
    details: { operation: "list-steps", provider: "vercel" },
  })
  expect(calls).toBe(cursors.length)
})

it.each([undefined, null, ""])("rejects an unfinished page with cursor %j", async (cursor) => {
  installStepsList(async () => ({ cursor, data: [], hasMore: true }))

  await expect(inspectVercelWorkflowRun("pagination", definition, "run-pagination")).rejects.toMatchObject({
    cause: { code: "WORKFLOW_R0026" },
    code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
    details: { operation: "list-steps", provider: "vercel" },
  })
})

it("rejects a step page with a non-boolean hasMore flag", async () => {
  installStepsList(async () => ({ data: [], hasMore: 0 } as unknown as { data: unknown[], hasMore: boolean }))

  await expect(inspectVercelWorkflowRun("pagination", definition, "run-pagination")).rejects.toMatchObject({
    cause: { code: "WORKFLOW_R0026" },
    code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
    details: { operation: "list-steps", provider: "vercel" },
  })
})

it("reads a terminal Vercel step page with a null cursor", async () => {
  const step = { attempt: 1, status: "completed", stepId: "step-one", stepName: "first" }
  installStepsList(async () => ({ cursor: null, data: [step], hasMore: false }))

  const result = await inspectVercelWorkflowRun("pagination", definition, "run-pagination")

  expect(result.steps).toMatchObject([{ id: "step-one", name: "first", status: "completed" }])
})
