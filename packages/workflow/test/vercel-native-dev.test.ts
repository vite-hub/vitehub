import { afterEach, expect, it, vi } from "vitest"

import { cancelWorkflow, getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { enableWorkflowDevRuns } from "../src/runtime/dev-runs.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"
import { setVercelWorkflowRuntimeLoader } from "../src/runtime/vercel.ts"

import type { VercelWorkflowRuntime } from "../src/runtime/vercel.ts"
import { unwrap } from "./unwrap.ts"

afterEach(() => {
  resetWorkflowRuntime()
})

function registerNativeWorkflow() {
  const handler = vi.fn(async ({ payload }: { payload: { email: string } }) => ({ inline: payload.email }))
  const native = vi.fn(async () => ({ durable: true }))
  const runtime: VercelWorkflowRuntime = {
    getRun: vi.fn(() => {
      throw new Error("A dev server must not read a Workflow DevKit run.")
    }),
    listSteps: vi.fn(async () => []),
    resumeHook: vi.fn(async () => ({ runId: "unused" })),
    start: vi.fn(async () => {
      throw new Error("'start' received an invalid workflow function.")
    }),
  }
  setVercelWorkflowRuntimeLoader(async () => runtime)
  setWorkflowRuntimeConfig({ driver: "vercel" })
  setWorkflowRuntimeRegistry({
    onboard: async () => ({ default: { handler, native } }),
  })
  return { handler, native, runtime }
}

it("runs the normal handler of a native Vercel entry inline on a development server", async () => {
  enableWorkflowDevRuns()
  const { handler, native, runtime } = registerNativeWorkflow()

  const started = await unwrap(startWorkflow("onboard", { email: "ada@example.com" }))
  expect(started).toMatchObject({ metadata: { mode: "inline" }, provider: "vercel", status: "queued" })
  await vi.waitFor(async () => {
    await expect(unwrap(getWorkflowRun("onboard", started.id))).resolves.toMatchObject({ status: "completed" })
  })
  const run = await unwrap(getWorkflowRun("onboard", started.id))
  expect(run.result).toEqual({ inline: "ada@example.com" })
  expect(await cancelWorkflow("onboard", started.id)).toMatchObject([{ code: "WORKFLOW_OPERATION_UNSUPPORTED" }, undefined])

  expect(handler).toHaveBeenCalledOnce()
  expect(native).not.toHaveBeenCalled()
  expect(runtime.start).not.toHaveBeenCalled()
  expect(runtime.getRun).not.toHaveBeenCalled()
})

it("keeps the native run id rule on a development server", async () => {
  enableWorkflowDevRuns()
  const { handler } = registerNativeWorkflow()

  expect(await startWorkflow("onboard", { email: "ada@example.com" }, { id: "run-1" })).toMatchObject([{ code: "WORKFLOW_RUN_ID_UNSUPPORTED" }, undefined])
  expect(handler).not.toHaveBeenCalled()
})

it("still starts the native entry outside a development server", async () => {
  const { handler, runtime } = registerNativeWorkflow()

  expect(await startWorkflow("onboard", { email: "ada@example.com" })).toMatchObject([{ code: "WORKFLOW_PROVIDER_OPERATION_FAILED" }, undefined])
  expect(runtime.start).toHaveBeenCalledOnce()
  expect(handler).not.toHaveBeenCalled()
})
