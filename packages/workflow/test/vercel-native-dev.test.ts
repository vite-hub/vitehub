import { afterEach, expect, it, vi } from "vitest"

import { cancelWorkflow, getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { enableWorkflowDevRuns } from "../src/runtime/dev-runs.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"
import { setVercelWorkflowRuntimeLoader } from "../src/runtime/vercel.ts"

import type { VercelWorkflowRuntime } from "../src/runtime/vercel.ts"

afterEach(() => {
  resetWorkflowRuntime()
})

// `vite dev` does not run the Workflow DevKit transform, so a native entry there has no `workflowId`.
function registerNativeWorkflow() {
  const handler = vi.fn(async (payload: { email: string }) => ({ inline: payload.email }))
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
  setWorkflowRuntimeConfig({ provider: "vercel" })
  setWorkflowRuntimeRegistry({
    onboard: async () => ({ default: { handler, options: { native } } }),
  })
  return { handler, native, runtime }
}

it("runs the normal handler of a native Vercel entry inline on a development server", async () => {
  enableWorkflowDevRuns()
  const { handler, native, runtime } = registerNativeWorkflow()

  const started = await startWorkflow("onboard", { email: "ada@example.com" })
  expect(started).toMatchObject({ metadata: { mode: "inline" }, provider: "vercel", status: "queued" })
  await vi.waitFor(async () => {
    await expect(getWorkflowRun("onboard", started.id)).resolves.toMatchObject({ status: "completed" })
  })
  const run = await getWorkflowRun("onboard", started.id)
  expect(run.result).toBeInstanceOf(Response)
  await expect((run.result as Response).json()).resolves.toEqual({ inline: "ada@example.com" })
  await expect(cancelWorkflow("onboard", started.id)).rejects.toMatchObject({ code: "WORKFLOW_OPERATION_UNSUPPORTED" })

  expect(handler).toHaveBeenCalledOnce()
  expect(native).not.toHaveBeenCalled()
  expect(runtime.start).not.toHaveBeenCalled()
  expect(runtime.getRun).not.toHaveBeenCalled()
})

it("keeps the native run id rule on a development server", async () => {
  enableWorkflowDevRuns()
  const { handler } = registerNativeWorkflow()

  // A deployed native entry rejects caller run ids, so the dev server does too.
  await expect(startWorkflow("onboard", { email: "ada@example.com" }, { id: "run-1" })).rejects.toMatchObject({ code: "WORKFLOW_RUN_ID_UNSUPPORTED" })
  expect(handler).not.toHaveBeenCalled()
})

it("still starts the native entry outside a development server", async () => {
  const { handler, runtime } = registerNativeWorkflow()

  await expect(startWorkflow("onboard", { email: "ada@example.com" })).rejects.toMatchObject({ code: "WORKFLOW_PROVIDER_OPERATION_FAILED" })
  expect(runtime.start).toHaveBeenCalledOnce()
  expect(handler).not.toHaveBeenCalled()
})
