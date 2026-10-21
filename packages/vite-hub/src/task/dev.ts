/** Vite Development Server route that `vitehub task` commands call. */
export const taskDevRoute = "/__vitehub/task/dev"
/** Nitro route that the dev endpoint forwards task operations to. The route exists only in `vite dev`. */
export const taskDevRuntimeRoute = "/_vitehub/task/dev"
export const taskDevHeader = "x-vitehub-task-dev"
export const taskDevHeaderValue = "1"
export const taskDevTokenNamespace = "task"
export const taskDevTokenServerHeader = "x-vitehub-task-dev-server"

export type TaskDevRequestBody =
  | { operation: "list" }
  | { name: string, operation: "run", payload: Record<string, unknown> }

/** One task that the Nitro runtime registers. */
export interface TaskDevSummary {
  description?: string
  name: string
}

export interface TaskDevListResult {
  tasks: TaskDevSummary[]
}

export interface TaskDevRunResult {
  durationMs: number
  name: string
  /** The `result` field that the task returns. */
  result?: unknown
}
