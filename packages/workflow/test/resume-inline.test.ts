import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { resumeWorkflow } from "../src/runtime/client.ts"
import { setWorkflowDevRecorder } from "../src/runtime/dev-recorder.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"
import { setVercelWorkflowRuntimeLoader } from "../src/runtime/vercel.ts"

import type { WorkflowDevRecorder } from "../src/runtime/dev-recorder.ts"
import { unwrap } from "./unwrap.ts"

const missingSdk = vi.fn(async () => {
  throw new Error("Cannot find package 'workflow'")
})

beforeEach(() => {
  resetWorkflowRuntime()
  missingSdk.mockClear()
  setVercelWorkflowRuntimeLoader(missingSdk)
  setWorkflowRuntimeConfig({ driver: "vercel" })
})

afterEach(() => {
  setWorkflowDevRecorder(undefined)
  setVercelWorkflowRuntimeLoader()
})

it("says that signals are unsupported in vite dev, where every run is inline", async () => {
  // SAFETY: resumeWorkflow() only checks that a dev recorder is installed.
  setWorkflowDevRecorder({} as WorkflowDevRecorder)
  setWorkflowRuntimeRegistry({
    welcome: async () => ({ default: { handler: async () => "inline", options: { native: async () => "native" } } }),
  })

  expect(await resumeWorkflow("hook-token", {})).toMatchObject([{
    code: "WORKFLOW_OPERATION_UNSUPPORTED",
    data: { operation: "signals", provider: "vercel" },
  }, undefined])
  expect(missingSdk).not.toHaveBeenCalled()
})

it("says that signals are unsupported when no Workflow has a native entry and the SDK is missing", async () => {
  setWorkflowRuntimeRegistry({
    welcome: async () => ({ default: { handler: async () => "inline" } }),
  })

  expect(await resumeWorkflow("hook-token", {})).toMatchObject([{
    code: "WORKFLOW_OPERATION_UNSUPPORTED",
    data: { operation: "signals", provider: "vercel" },
  }, undefined])
})

it("still asks for the Workflow DevKit when a Workflow has a native entry", async () => {
  setWorkflowRuntimeRegistry({
    welcome: async () => ({ default: { handler: async () => "inline", options: { native: async () => "native" } } }),
  })

  await expect(resumeWorkflow("hook-token", {})).rejects.toMatchObject({
    code: "VERCEL_WORKFLOW_SDK_LOAD_FAILED",
    details: { provider: "vercel" },
  })
})
