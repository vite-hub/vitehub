/**
 * Nitro tasks. Put one task in each `server/tasks/` file, then run it with `vitehub task run <name>`.
 *
 * ```ts [server/tasks/seed.ts]
 * import { defineTask } from "vite-hub/task"
 *
 * export default defineTask({
 *   meta: { description: "Add demo rows" },
 *   async run({ payload }) {
 *     return { result: "ok" }
 *   },
 * })
 * ```
 */
export { defineTask, runTask } from "nitro/task"
export type { Task, TaskContext, TaskEvent, TaskMeta, TaskPayload, TaskResult } from "nitro/types"
