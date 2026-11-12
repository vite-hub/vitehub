import { defineOperation, table } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { ManualScheduleRunSummary, ScheduleAttemptsResult, ScheduleListResult, ScheduleRunAttemptSummary, ScheduleRunResult, ScheduleRunSummary, ScheduleRunsResult, StartedScheduleResult, StartedScheduleSummary } from "./runtime/operations.ts"

// The runtime module reads the run store and the registry of the Nitro runtime. The operations load it when they run, so
// the CLI and `vitehub inspect` can list them without it.
const runtime = () => import("./runtime/operations.ts")

const id = v.pipe(v.string(), v.minLength(1))

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
  return `${run.status} ${run.scheduleId}${time}${run.error ? `: ${run.error.message}` : ""}\nRun ${run.id}\nScheduled at ${run.scheduledAt}\n`
}

function defineScheduleOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">): OperationDefinition<Input, Output> {
  // The run store answers for the section. The operations never read the signed-in user.
  return defineOperation({ ...definition, section: "schedules", user: false })
}

const runs = defineScheduleOperation<{ id: string, limit?: number }, ScheduleRunsResult>({
  cli: { command: "runs", format: formatRuns, namespace: "schedule", positional: ["id"] },
  description: "List the recorded runs of one Schedule Definition, newest first.",
  input: v.object({ id, limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))) }),
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

const run = defineScheduleOperation<{ at?: string, name: string }, ScheduleRunResult>({
  cli: { command: "run", format: formatRun, namespace: "schedule", positional: ["name"] },
  description: "Run a Static Schedule Definition now. The definition must set `manual: true`. `at` runs it as if the cron fired at that ISO 8601 date-time.",
  input: v.object({ at: v.optional(v.string()), name: id }),
  invoke: true,
  kind: "write",
  name: "schedule.run",
  run: async input => await (await runtime()).runScheduleNow(input),
})

function timingOf(schedule: StartedScheduleSummary): string {
  if (schedule.at) return `once at ${schedule.at}`
  return schedule.timeZone && schedule.timeZone !== "UTC" ? `${schedule.cron} (${schedule.timeZone})` : schedule.cron ?? "-"
}

function formatSchedules({ schedules }: { schedules: readonly StartedScheduleSummary[] }): string {
  if (schedules.length === 0) return "No started Schedules.\n"
  return `${table([
    ["ID", "SCHEDULE", "RUNS", "STARTED AT"],
    ...schedules.map(schedule => [schedule.id, schedule.name, timingOf(schedule), schedule.createdAt]),
  ])}\n`
}

function formatStartedSchedule(verb: string) {
  return ({ schedule }: { schedule: StartedScheduleSummary }) => `${verb} ${schedule.id}: ${schedule.name}, ${timingOf(schedule)}\n`
}

const list = defineScheduleOperation<{ name?: string }, ScheduleListResult>({
  cli: { command: "list", format: formatSchedules, namespace: "schedule", positional: ["name"] },
  description: "List the Schedules that code started with startSchedule(), oldest first. `name` keeps the Schedules of one Definition.",
  input: v.object({ name: v.optional(id) }),
  kind: "read",
  name: "schedule.list",
  run: async input => await (await runtime()).runScheduleList(input),
})

const start = defineScheduleOperation<{ at?: string, cron?: string, name: string, payload?: unknown, timeZone?: string }, StartedScheduleResult>({
  cli: { command: "start", format: formatStartedSchedule("Started"), namespace: "schedule", positional: ["name"] },
  description: "Start a Schedule Definition without cron: once at `at` (ISO 8601 with a time zone), or on `cron` in `timeZone` until you cancel it. `payload` reaches the handler as `context.payload`.",
  input: v.object({ at: v.optional(v.string()), cron: v.optional(v.string()), name: id, payload: v.optional(v.unknown()), timeZone: v.optional(v.string()) }),
  invoke: true,
  kind: "write",
  name: "schedule.start",
  run: async input => await (await runtime()).runScheduleStart(input),
})

const cancel = defineScheduleOperation<{ id: string }, StartedScheduleResult>({
  cli: { command: "cancel", format: formatStartedSchedule("Cancelled"), namespace: "schedule", positional: ["id"] },
  description: "Cancel a started Schedule, so it does not run again.",
  input: v.object({ id }),
  kind: "destructive",
  name: "schedule.cancel",
  run: async input => await (await runtime()).runScheduleCancel(input),
})

/**
 * The `schedule.*` operations: runs, attempts, run, list, start, and cancel. The Console, `vitehub schedule`, and agents
 * run them.
 */
export const scheduleOperations: readonly AnyOperation[] = [runs, attempts, run, list, start, cancel]

export type { ScheduleAttemptsResult, ScheduleListResult, ScheduleRunResult, ScheduleRunsResult, StartedScheduleResult }
