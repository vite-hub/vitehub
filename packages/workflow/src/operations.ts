import { defineOperation, table } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { WorkflowRunDetailView, WorkflowRunResult, WorkflowRunsClearResult, WorkflowRunsListResult, WorkflowRunsListStatus, WorkflowRunView, WorkflowSignalResult } from "./results.ts"

const runtime = () => import("./runtime/operations.ts")

const name = v.pipe(v.string(), v.check(value => value.trim() !== "", "Name a Workflow."))
const runId = v.pipe(v.string(), v.check(value => value.trim() !== "", "Pass the id of a run."))
const maxRequestBytes = 1024 * 1024

function defineWorkflowOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">): OperationDefinition<Input, Output> {
  return defineOperation({ ...definition, cli: { namespace: "workflow", ...definition.cli }, section: "workflows", user: false })
}

const start = defineWorkflowOperation<{ payload?: unknown, workflow: string }, WorkflowRunResult>({
  cli: { positional: ["workflow", "payload"] },
  description: "Start a Workflow run by name. The payload is any JSON value.",
  input: v.object({ payload: v.optional(v.unknown()), workflow: name }),
  invoke: true,
  kind: "write",
  maxRequestBytes,
  name: "workflow.start",
  run: async input => (await runtime()).runWorkflowOperation("start", input),
})

const get = defineWorkflowOperation<{ runId: string, workflow?: string }, WorkflowRunResult>({
  cli: { command: "runs get", format: formatRun, positional: ["runId"] },
  description: "Show the status and result of a Workflow run, with its steps when `vite dev` recorded it. OpenWorkflow finds the Workflow of a stored run from its id. On other providers, pass `workflow` for a run that this runtime did not start.",
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
  cli: { positional: ["token", "payload"] },
  description: "Resume a Workflow signal with its opaque token. The payload is any JSON value.",
  input: v.object({ payload: v.optional(v.unknown()), token: v.pipe(v.string(), v.check(value => value.trim() !== "", "Pass the signal token.")) }),
  invoke: true,
  kind: "write",
  maxRequestBytes,
  name: "workflow.resume",
  run: async input => (await runtime()).runWorkflowOperation("resume", input),
})

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

/** The steps of a run that `vite dev` recorded. A run of another runtime has no steps. */
function stepLines(steps: WorkflowRunDetailView["steps"] | undefined): string[] {
  if (!steps) return []
  if (!steps.length) return ["Steps: none"]
  return ["Steps:", table([
    ["STEP", "STATUS", "STARTED AT", "COMPLETED AT", "ERROR"],
    ...steps.map(step => [step.name, step.status, step.startedAt, step.completedAt ?? "-", step.error?.message ?? "-"]),
  ])]
}

function formatRun({ run }: { run: WorkflowRunView & Partial<Pick<WorkflowRunDetailView, "steps">> }): string {
  return [
    `Run: ${run.id}`,
    `Workflow: ${run.workflow}`,
    `Status: ${run.status}`,
    `Provider: ${run.provider}`,
    ...(run.createdAt ? [`Created at: ${run.createdAt}`] : []),
    ...(run.startedAt ? [`Started at: ${run.startedAt}`] : []),
    ...(run.completedAt ? [`Completed at: ${run.completedAt}`] : []),
    ...(run.error ? [`Error: ${run.error.code ? `${run.error.code} ` : ""}${run.error.message}`] : []),
    ...stepLines(run.steps),
    ...(run.status === "completed" ? ["Result:", json(run.result)] : []),
    "",
  ].join("\n")
}

const runsList = defineWorkflowOperation<{ limit?: number, status?: WorkflowRunsListStatus, workflow?: string }, WorkflowRunsListResult>({
  cli: { command: "runs list", format: formatRuns },
  description: "List Workflow runs, newest first: the runs that OpenWorkflow stores, and the inline runs that `vite dev` recorded. Other providers outside `vite dev` fail with WORKFLOW_RUNS_UNAVAILABLE.",
  input: v.strictObject({
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))),
    status: v.optional(v.picklist(["queued", "running", "completed", "failed"])),
    workflow: v.optional(name),
  }),
  kind: "read",
  name: "workflow.runs-list",
  run: async input => (await runtime()).listWorkflowRuns(input),
})

const runsClear = defineWorkflowOperation<Record<string, never>, WorkflowRunsClearResult>({
  cli: { command: "runs clear", format: ({ cleared }) => `Cleared ${cleared} ${cleared === 1 ? "run" : "runs"}.\n` },
  description: "Remove the inline Workflow runs that `vite dev` recorded. Stored OpenWorkflow runs stay. Outside `vite dev` it fails with WORKFLOW_RUNS_UNAVAILABLE.",
  input: v.strictObject({}),
  kind: "destructive",
  name: "workflow.runs-clear",
  run: async () => (await runtime()).clearWorkflowRuns(),
})

/**
 * The `workflow.*` operations: start, get, cancel, resume, and the run history of `vite dev`. The Console,
 * `vitehub workflow`, and agents run them.
 */
export const workflowOperations: readonly AnyOperation[] = [start, get, cancel, resume, runsList, runsClear]

export type { WorkflowRunDetailView, WorkflowRunResult, WorkflowRunsClearResult, WorkflowRunsListResult, WorkflowRunsListStatus, WorkflowRunStepView, WorkflowRunView, WorkflowSignalResult, WorkflowSignalView } from "./results.ts"
