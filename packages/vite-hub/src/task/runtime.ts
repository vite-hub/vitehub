import { redactInspectionText } from "@vite-hub/internal/inspect"
import { runTask } from "nitro/task"

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

/** A failure with the fields that every surface reports. */
class TaskOperationError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly fix?: string) {
    super(redactInspectionText(message))
  }
}

const registryKey: unique symbol = Symbol.for(taskRegistryKey)
const scope = globalThis as typeof globalThis & { [registryKey]?: NitroTaskRegistry }

function registry(): NitroTaskRegistry {
  const tasks = scope[registryKey]
  if (!tasks) {
    throw new TaskOperationError("Nitro tasks are not enabled in this runtime.", 503, "TASK_RUNTIME_UNAVAILABLE", "Add a file to `server/tasks/` and build again. In Nuxt, use Nuxt's own task support.")
  }
  return tasks
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object(value) === value && !Array.isArray(value)
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
    throw new TaskOperationError(`Task "${name}" does not exist.`, 404, "TASK_NOT_FOUND", "Run `vitehub task list` to see the registered tasks.")
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
    const message = error instanceof Error ? error.message : String(error)
    const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined
    throw status === 501
      ? new TaskOperationError(message, 501, "TASK_NOT_IMPLEMENTED", "Export a default `defineTask()` with a `run()` method from the task file.")
      : new TaskOperationError(`Task "${name}" failed: ${message}`, 500, "TASK_FAILED", "Read the server log for the stack.")
  }
}
