import type { WorkflowDriver } from "../types.ts"

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
  provider: WorkflowDriver
  result?: unknown
  startedAt?: Date
  status: "completed" | "failed" | "queued" | "running"
  steps: WorkflowDevStepRecord[]
  workflow: string
}

/** Runs the handler of a recorded run and records its status, result, and error. */
export type WorkflowDevRunner = <T>(run: () => Promise<T>) => Promise<T>

/** Records the inline runs of `vite dev`. */
export interface WorkflowDevRecorder {
  /** Removes all recorded runs and returns how many it removed. */
  clear(): number
  /** One recorded run. */
  get(workflow: string, id: string): WorkflowDevRunRecord | undefined
  /** The recorded runs, newest first. */
  list(): WorkflowDevRunRecord[]
  /** Records a new queued run. */
  start(workflow: string, id: string, provider: WorkflowDriver): WorkflowDevRunner
  /** Runs one step and records it on the active run. */
  step<T>(name: string, run: () => T | Promise<T>): Promise<T>
}

/** The dev server keeps the newest runs only, so a long session does not grow without limit. */
export const workflowDevRunLimit = 200

let recorder: WorkflowDevRecorder | undefined

export function setWorkflowDevRecorder(value: WorkflowDevRecorder | undefined): void {
  recorder = value
}

export function getWorkflowDevRecorder(): WorkflowDevRecorder | undefined {
  return recorder
}
