import { AsyncLocalStorage } from "node:async_hooks"

import type { WorkflowProvider } from "../types.ts"

// The run history of `vite dev`. Inline runs keep no history: the runtime forgets a finished run after five minutes and
// never records its steps. The dev Nitro plugin turns this history on, so a build never records it.

/** One step of a recorded run. */
export interface WorkflowDevStepRecord {
  completedAt?: Date
  error?: unknown
  name: string
  output?: unknown
  startedAt: Date
  status: "completed" | "failed" | "running"
}

/** One inline run that `vite dev` recorded. */
export interface WorkflowDevRunRecord {
  completedAt?: Date
  createdAt: Date
  error?: unknown
  id: string
  provider: WorkflowProvider
  result?: unknown
  startedAt?: Date
  status: "completed" | "failed" | "queued" | "running"
  steps: WorkflowDevStepRecord[]
  workflow: string
}

/** The dev server keeps the newest runs only, so a long session does not grow without limit. */
export const workflowDevRunLimit = 200

let enabled = false
const runs = new Map<string, WorkflowDevRunRecord>()
const activeRun = new AsyncLocalStorage<WorkflowDevRunRecord>()

/** Turns on the run history. Only the dev Nitro plugin calls it. */
export function enableWorkflowDevRuns(): void {
  enabled = true
}

export function workflowDevRunsEnabled(): boolean {
  return enabled
}

export function resetWorkflowDevRuns(): void {
  enabled = false
  runs.clear()
}

/** The recorded runs, newest first. */
export function listWorkflowDevRuns(): WorkflowDevRunRecord[] {
  return [...runs.values()].reverse()
}

/** Records a new inline run when the history is on. */
export function createWorkflowDevRun(workflow: string, id: string, provider: WorkflowProvider): WorkflowDevRunRecord | undefined {
  if (!enabled) return
  const key = JSON.stringify([workflow, id])
  const record: WorkflowDevRunRecord = { createdAt: new Date(), id, provider, status: "queued", steps: [], workflow }
  runs.delete(key)
  runs.set(key, record)
  while (runs.size > workflowDevRunLimit) runs.delete(runs.keys().next().value!)
  return record
}

/** Runs the handler of an inline run and records its status, result, and error. */
export async function runWorkflowDevRun<T>(record: WorkflowDevRunRecord | undefined, run: () => Promise<T>): Promise<T> {
  if (!record) return await run()
  record.startedAt = new Date()
  record.status = "running"
  try {
    const result = await activeRun.run(record, run)
    record.result = result
    record.status = "completed"
    return result
  }
  catch (error) {
    record.error = error
    record.status = "failed"
    throw error
  }
  finally {
    record.completedAt = new Date()
  }
}

/** Runs one step of an inline run and records it on the run, if `vite dev` records the run. */
export async function runWorkflowDevStep<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  const record = activeRun.getStore()
  // The root step wraps the whole handler. The run already records it.
  if (!record || name === record.workflow) return await run()
  const step: WorkflowDevStepRecord = { name, startedAt: new Date(), status: "running" }
  record.steps.push(step)
  try {
    const output = await run()
    step.output = output
    step.status = "completed"
    return output
  }
  catch (error) {
    step.error = error
    step.status = "failed"
    throw error
  }
  finally {
    step.completedAt = new Date()
  }
}
