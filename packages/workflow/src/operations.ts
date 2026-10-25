import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { WorkflowRunResult, WorkflowSignalResult } from "./results.ts"

// The runtime module reads the Workflow state of the app, which only exists in the Nitro runtime. The operations load it
// when they run, so the CLI and `vitehub inspect` can list them without it.
const runtime = () => import("./runtime/operations.ts")

const name = v.pipe(v.string(), v.check(value => value.trim() !== "", "Name a Workflow."))
const runId = v.pipe(v.string(), v.check(value => value.trim() !== "", "Pass the id of a run."))
// A payload can be larger than the default request limit of a call.
const maxRequestBytes = 1024 * 1024

function defineWorkflowOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">): OperationDefinition<Input, Output> {
  // The Console section is `workflows`. The commands are `vitehub workflow <verb>`. The runtime never reads the user.
  return defineOperation({ ...definition, cli: { namespace: "workflow", ...definition.cli }, section: "workflows", user: false })
}

const start = defineWorkflowOperation<{ payload?: unknown, workflow: string }, WorkflowRunResult>({
  cli: { positional: ["workflow"] },
  description: "Start a Workflow run by name. The payload is any JSON value.",
  input: v.object({ payload: v.optional(v.unknown()), workflow: name }),
  invoke: true,
  kind: "write",
  maxRequestBytes,
  name: "workflow.start",
  run: async input => (await runtime()).runWorkflowOperation("start", input),
})

const get = defineWorkflowOperation<{ runId: string, workflow?: string }, WorkflowRunResult>({
  cli: { positional: ["runId"] },
  description: "Show the status and result of a Workflow run. Pass `workflow` for a run that this runtime did not start.",
  input: v.object({ runId, workflow: v.optional(name) }),
  kind: "read",
  name: "workflow.get",
  run: async input => (await runtime()).runWorkflowOperation("get", input),
})

const cancel = defineWorkflowOperation<{ runId: string, workflow?: string }, WorkflowRunResult>({
  cli: { positional: ["runId"] },
  description: "Cancel a Workflow run. Only providers that support cancellation accept it.",
  input: v.object({ runId, workflow: v.optional(name) }),
  kind: "destructive",
  name: "workflow.cancel",
  run: async input => (await runtime()).runWorkflowOperation("cancel", input),
})

const resume = defineWorkflowOperation<{ payload?: unknown, token: string }, WorkflowSignalResult>({
  cli: { positional: ["token"] },
  description: "Resume a Workflow signal with its opaque token. The payload is any JSON value.",
  input: v.object({ payload: v.optional(v.unknown()), token: v.pipe(v.string(), v.check(value => value.trim() !== "", "Pass the signal token.")) }),
  kind: "write",
  maxRequestBytes,
  name: "workflow.resume",
  run: async input => (await runtime()).runWorkflowOperation("resume", input),
})

/** The `workflow.*` operations: start, get, cancel, and resume. The Console, `vitehub workflow`, and agents run them. */
export const workflowOperations: readonly AnyOperation[] = [start, get, cancel, resume]

export type { WorkflowRunResult, WorkflowRunView, WorkflowSignalResult, WorkflowSignalView } from "./results.ts"
