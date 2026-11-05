import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { WorkflowRunDetailView, WorkflowRunResult, WorkflowRunsListResult, WorkflowRunsShowResult, WorkflowSignalResult } from "./results.ts"
import type { WorkflowRunStatus } from "./types.ts"

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
  invoke: true,
  kind: "write",
  maxRequestBytes,
  name: "workflow.resume",
  run: async input => (await runtime()).runWorkflowOperation("resume", input),
})

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")).join("\n")
}

function formatRuns({ runs }: WorkflowRunsListResult): string {
  if (runs.length === 0) return "No runs.\n"
  return `${table([
    ["RUN", "WORKFLOW", "STATUS", "CREATED AT", "STEPS", "ERROR"],
    ...runs.map(run => [run.id, run.workflow, run.status, run.createdAt ?? "-", String(run.stepCount), run.error?.message ?? "-"]),
  ])}\n`
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2)
}

function formatRun({ run }: { run: WorkflowRunDetailView }): string {
  return [
    `Run: ${run.id}`,
    `Workflow: ${run.workflow}`,
    `Status: ${run.status}`,
    `Provider: ${run.provider}`,
    ...(run.createdAt ? [`Created at: ${run.createdAt}`] : []),
    ...(run.startedAt ? [`Started at: ${run.startedAt}`] : []),
    ...(run.completedAt ? [`Completed at: ${run.completedAt}`] : []),
    ...(run.error ? [`Error: ${run.error.code ? `${run.error.code} ` : ""}${run.error.message}`] : []),
    ...(run.steps.length
      ? ["Steps:", table([
          ["STEP", "STATUS", "STARTED AT", "COMPLETED AT", "ERROR"],
          ...run.steps.map(step => [step.name, step.status, step.startedAt, step.completedAt ?? "-", step.error?.message ?? "-"]),
        ])]
      : ["Steps: none"]),
    ...(run.status === "completed" ? ["Result:", json(run.result)] : []),
    "",
  ].join("\n")
}

const runsList = defineWorkflowOperation<{ limit?: number, status?: WorkflowRunStatus, workflow?: string }, WorkflowRunsListResult>({
  cli: { command: "runs list", format: formatRuns },
  description: "List the Workflow runs that `vite dev` recorded, newest first. Other runtimes keep no history and fail with WORKFLOW_RUNS_UNAVAILABLE.",
  input: v.strictObject({
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))),
    status: v.optional(v.picklist(["queued", "running", "completed", "failed"])),
    workflow: v.optional(name),
  }),
  kind: "read",
  name: "workflow.runs-list",
  run: async input => (await runtime()).listWorkflowRuns(input),
})

const runsShow = defineWorkflowOperation<{ id: string, workflow?: string }, WorkflowRunsShowResult>({
  cli: { command: "runs show", format: formatRun, positional: ["id"] },
  description: "Show one Workflow run that `vite dev` recorded, with its steps, status, result, and error.",
  input: v.strictObject({ id: runId, workflow: v.optional(name) }),
  kind: "read",
  name: "workflow.runs-show",
  run: async input => (await runtime()).showWorkflowRun(input),
})

/**
 * The `workflow.*` operations: start, get, cancel, resume, and the run history of `vite dev`. The Console,
 * `vitehub workflow`, and agents run them.
 */
export const workflowOperations: readonly AnyOperation[] = [start, get, cancel, resume, runsList, runsShow]

export type { WorkflowRunDetailView, WorkflowRunResult, WorkflowRunsListResult, WorkflowRunsShowResult, WorkflowRunStepView, WorkflowRunView, WorkflowSignalResult, WorkflowSignalView } from "./results.ts"
