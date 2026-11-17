import { redactInspectionText } from "@vite-hub/internal/inspect"
import { isRecordOrFunction as isRecord } from "@vite-hub/internal/object"
import { runTask } from "nitro/task"

import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"
import { taskRegistryKey } from "./registry.ts"

/** Shape of the `tasks` export of Nitro's `#nitro/virtual/tasks` module. */
export type NitroTaskRegistry = Record<string, {
  meta?: { description?: string }
  resolve?: () => Promise<{ meta?: { description?: string } }>
}>

/** One task that the Nitro runtime registers. */
export interface TaskSummary {
  description?: string
  name: string
}

export interface TaskListResult {
  tasks: TaskSummary[]
}

export interface TaskRunResult {
  durationMs: number
  name: string
  /** The `result` field that the task returns. */
  result?: unknown
}

/** The HTTP status that every surface reports for a task failure. */
function withStatus<T extends Error>(error: T, status: number): T & { status: number } {
  return Object.assign(error, { status })
}

const registryKey: unique symbol = Symbol.for(taskRegistryKey)
const scope = globalThis as typeof globalThis & { [registryKey]?: NitroTaskRegistry }

function registry(): NitroTaskRegistry {
  const tasks = scope[registryKey]
  if (!tasks) {
    throw withStatus(viteHubErrorDiagnostics.TASK_RUNTIME_UNAVAILABLE(), 503)
  }
  return tasks
}

export async function listTasks(): Promise<TaskListResult> {
  const tasks = await Promise.all(Object.entries(registry()).map(async ([name, task]): Promise<TaskSummary> => {
    let description = task.meta?.description
    if (description === undefined && task.resolve) {
      try {
        description = (await task.resolve()).meta?.description
      }
      catch {
        // A broken lazy module must not hide the other registered tasks.
      }
    }
    return description ? { description: redactInspectionText(description), name } : { name }
  }))
  return { tasks: tasks.sort((left, right) => left.name.localeCompare(right.name)) }
}

/** Runs one task with Nitro's `runTask()`, so it uses the same bindings, runtime config, and plugins as a request. */
export async function runNamedTask(name: string, payload: Record<string, unknown> = {}): Promise<TaskRunResult> {
  if (!Object.hasOwn(registry(), name)) {
    throw withStatus(viteHubErrorDiagnostics.TASK_NOT_FOUND({ name: redactInspectionText(name) }), 404)
  }
  const startedAt = performance.now()
  try {
    const output: unknown = await runTask(name, { context: {}, payload })
    const result: TaskRunResult = { durationMs: Math.round(performance.now() - startedAt), name }
    if (isRecord(output) && output.result !== undefined) result.result = output.result
    return result
  }
  catch (error) {
    // The server log keeps the stack. The caller gets the message.
    console.error(`[vitehub] Task "${name}" failed.`, error)
    const detail = redactInspectionText(error instanceof Error ? error.message : String(error))
    const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined
    throw status === 501
      ? withStatus(viteHubErrorDiagnostics.TASK_NOT_IMPLEMENTED({ detail }), 501)
      : withStatus(viteHubErrorDiagnostics.TASK_FAILED({ detail, name: redactInspectionText(name) }), 500)
  }
}
