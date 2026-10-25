import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { TaskListResult, TaskRunResult } from "./runtime.ts"

// The runtime module reaches the Nitro task registry of the generated server. The operations load it when they run, so
// the CLI and `vitehub inspect` can list them without it.
const runtime = () => import("./runtime.ts")

function defineTaskOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "cli" | "section" | "user"> & { cli?: Omit<NonNullable<OperationDefinition<Input, Output>["cli"]>, "namespace"> }): OperationDefinition<Input, Output> {
  // Tasks have no Console page. `tasks` is the section id that `console.authorize` grants, and `vitehub task` the CLI name.
  return defineOperation({ ...definition, cli: { ...definition.cli, namespace: "task" }, section: "tasks", user: false })
}

const list = defineTaskOperation<Record<string, never>, TaskListResult>({
  description: "List the Nitro tasks that the app registers, such as the files in server/tasks/.",
  input: v.strictObject({}),
  kind: "read",
  name: "task.list",
  run: async () => (await runtime()).listTasks(),
})

const run = defineTaskOperation<{ name: string, payload?: Record<string, unknown> }, TaskRunResult>({
  cli: { positional: ["name"] },
  description: "Run one Nitro task, such as a seed or a backfill, with the bindings of the app. `payload` is a JSON object.",
  input: v.strictObject({
    name: v.pipe(v.string(), v.minLength(1)),
    payload: v.optional(v.record(v.string(), v.unknown())),
  }),
  invoke: true,
  // A task can be a seed or a reset, so the CLI asks for `--yes` and agents need approval.
  kind: "destructive",
  name: "task.run",
  run: async ({ name, payload }) => (await runtime()).runNamedTask(name, payload),
})

/** The `task.*` operations: list and run. The Console, `vitehub task`, and agents run them. */
export const taskOperations: readonly AnyOperation[] = [list, run]

export type { TaskListResult, TaskRunResult }
