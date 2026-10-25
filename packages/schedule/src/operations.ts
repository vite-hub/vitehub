import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { ManualScheduleRunSummary, ScheduleAttemptsResult, ScheduleRunAttemptSummary, ScheduleRunResult, ScheduleRunSummary, ScheduleRunsResult } from "./runtime/operations.ts"

// The runtime module reads the run store and the registry of the Nitro runtime. The operations load it when they run, so
// the CLI and `vitehub inspect` can list them without it.
const runtime = () => import("./runtime/operations.ts")

const id = v.pipe(v.string(), v.minLength(1))

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")).join("\n")
}

function formatRuns({ runs }: { runs: readonly ScheduleRunSummary[] }): string {
  if (runs.length === 0) return "No runs.\n"
  return `${table([
    ["RUN", "STATUS", "SCHEDULED AT", "ATTEMPTS", "ERROR"],
    ...runs.map(run => [run.id, run.status, run.scheduledAt, String(run.attemptCount), run.error?.message ?? "-"]),
  ])}\n`
}

function formatAttempts({ attempts, run }: { attempts: readonly ScheduleRunAttemptSummary[], run: ScheduleRunSummary }): string {
  const header = `Run: ${run.id} (${run.status})\n`
  if (attempts.length === 0) return `${header}No attempts.\n`
  return `${header}${table([
    ["ATTEMPT", "STATUS", "STARTED AT", "COMPLETED AT", "ERROR"],
    ...attempts.map(attempt => [attempt.id, attempt.status, attempt.startedAt, attempt.completedAt ?? "-", attempt.error?.message ?? "-"]),
  ])}\n`
}

function formatRun({ run }: { run: ManualScheduleRunSummary }): string {
  const started = Date.parse(run.startedAt ?? "")
  const completed = Date.parse(run.completedAt ?? "")
  const duration = Number.isNaN(started) || Number.isNaN(completed) ? undefined : Math.max(0, completed - started)
  const time = duration === undefined ? "" : ` in ${duration < 1_000 ? `${duration} ms` : `${(duration / 1_000).toFixed(1)} s`}`
  return `${run.status} ${run.scheduleId}${time}${run.error ? `: ${run.error.message}` : ""}\nRun ${run.id}\n`
}

function defineScheduleOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">): OperationDefinition<Input, Output> {
  // The run store answers for the section. The operations never read the signed-in user.
  return defineOperation({ ...definition, section: "schedules", user: false })
}

const runs = defineScheduleOperation<{ id: string, limit?: number }, ScheduleRunsResult>({
  cli: { command: "runs", format: formatRuns, namespace: "schedule", positional: ["id"] },
  description: "List the recorded runs of one Schedule Definition, newest first.",
  input: v.object({ id, limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))) }),
  kind: "read",
  name: "schedule.runs",
  run: async input => await (await runtime()).runScheduleRuns(input),
})

const attempts = defineScheduleOperation<{ id: string }, ScheduleAttemptsResult>({
  cli: { command: "attempts", format: formatAttempts, namespace: "schedule", positional: ["id"] },
  description: "List the attempts of one Schedule Run, oldest first.",
  input: v.object({ id }),
  kind: "read",
  name: "schedule.attempts",
  run: async input => await (await runtime()).runScheduleAttempts(input),
})

const run = defineScheduleOperation<{ name: string }, ScheduleRunResult>({
  cli: { command: "run", format: formatRun, namespace: "schedule", positional: ["name"] },
  description: "Run a Static Schedule Definition now. The definition must set `manual: true`.",
  input: v.object({ name: id }),
  kind: "write",
  name: "schedule.run",
  run: async input => await (await runtime()).runScheduleNow(input),
})

/** The `schedule.*` operations: runs, attempts, and run. The Console, `vitehub schedule`, and agents run them. */
export const scheduleOperations: readonly AnyOperation[] = [runs, attempts, run]

export type { ScheduleAttemptsResult, ScheduleRunResult, ScheduleRunsResult }
