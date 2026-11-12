import type { ViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"
import type { WorkflowDriver, WorkflowRun } from "../types.ts"

/** One Workflow run that the app started while test mode was on. */
export interface WorkflowTestRun {
  deferred: boolean
  id: string
  payload: unknown
  status: "queued" | "cancelled"
  workflow: string
}

/** The started runs of the current test. `vite-hub/test` reads the same list. */
export function workflowTestRuns(test: ViteHubTestMode): WorkflowTestRun[] {
  return test.backend("workflow", () => [] as WorkflowTestRun[])
}

function toWorkflowRun<TPayload>(run: WorkflowTestRun, provider: WorkflowDriver): WorkflowRun<TPayload, unknown> {
  // SAFETY: The run stores the payload that the caller passed with this payload type.
  return { id: run.id, payload: run.payload as TPayload, provider, status: run.status }
}

/** Records the run and does not start its handler, so a test asserts what the app started. */
export function recordWorkflowTestRun<TPayload>(test: ViteHubTestMode, provider: WorkflowDriver, input: { deferred: boolean, id: string, name: string, payload: TPayload | undefined }): WorkflowRun<TPayload, unknown> {
  const runs = workflowTestRuns(test)
  const existing = runs.find(run => run.workflow === input.name && run.id === input.id)
  // A run id starts one run, as with every provider, so a second start returns the first run.
  if (existing) return toWorkflowRun(existing, provider)
  const run: WorkflowTestRun = { deferred: input.deferred, id: input.id, payload: structuredClone(input.payload), status: "queued", workflow: input.name }
  runs.push(run)
  return toWorkflowRun(run, provider)
}

/** Returns a recorded run, or a run with status `unknown` when the test started no run with this id. */
export function getWorkflowTestRun(test: ViteHubTestMode, provider: WorkflowDriver, name: string, id: string, cancel = false): WorkflowRun<unknown, unknown> {
  const run = workflowTestRuns(test).find(item => item.workflow === name && item.id === id)
  if (!run) return { id, provider, status: "unknown" }
  if (cancel) run.status = "cancelled"
  return toWorkflowRun(run, provider)
}
