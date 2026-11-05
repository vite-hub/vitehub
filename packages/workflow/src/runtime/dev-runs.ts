import { AsyncLocalStorage } from "node:async_hooks"

import { getWorkflowDevRecorder, setWorkflowDevRecorder, workflowDevRunLimit } from "./dev-recorder.ts"

import type { WorkflowDevRecorder, WorkflowDevRunRecord, WorkflowDevStepRecord } from "./dev-recorder.ts"

// The run history of `vite dev`. Inline runs keep no history: the runtime forgets a finished run after five minutes and
// never records its steps. Only the dev Nitro plugin imports this module, so a build does not include it.

function createWorkflowDevRecorder(): WorkflowDevRecorder {
  const runs = new Map<string, WorkflowDevRunRecord>()
  const activeRun = new AsyncLocalStorage<WorkflowDevRunRecord>()
  return {
    clear() {
      const count = runs.size
      runs.clear()
      return count
    },
    list: () => [...runs.values()].reverse(),
    start(workflow, id, provider) {
      const key = JSON.stringify([workflow, id])
      const record: WorkflowDevRunRecord = { createdAt: new Date(), id, provider, status: "queued", steps: [], workflow }
      runs.delete(key)
      runs.set(key, record)
      while (runs.size > workflowDevRunLimit) runs.delete(runs.keys().next().value!)
      return async (run) => {
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
    },
    async step(name, run) {
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
    },
  }
}

/** Turns on the run history. Only the dev Nitro plugin calls it. A second call keeps the history. */
export function enableWorkflowDevRuns(): void {
  if (!getWorkflowDevRecorder()) setWorkflowDevRecorder(createWorkflowDevRecorder())
}
