import { requestConsole } from "./request.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

/** One manual Schedule run as the Schedules page shows it. `unavailable` means the run did not start. */
export interface ConsoleScheduleRunView {
  durationMs?: number
  error?: string
  id?: string
  status: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

function text(value: unknown): string | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
  return typeof value === "string" ? value : undefined
}

export function parseConsoleScheduleRun(value: unknown): ConsoleScheduleRunView {
  const run = record(record(value)?.run)
  const status = text(run?.status)
  if (!run || !status) throw viteHubErrorDiagnostics.VITE_HUB_R0098({ message: "The Console returned an invalid Schedule run." })
  const durationMs = Date.parse(text(run.completedAt) ?? "") - Date.parse(text(run.startedAt) ?? "")
  const error = text(record(run.error)?.message)
  const id = text(run.id)
  return {
    ...(Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs) } : {}),
    ...(error ? { error } : {}),
    ...(id ? { id } : {}),
    status,
  }
}

export function consoleScheduleRunDescription(run: ConsoleScheduleRunView): string {
  const duration = run.durationMs === undefined
    ? undefined
    : run.durationMs < 1_000 ? `${run.durationMs}ms` : `${(run.durationMs / 1_000).toFixed(1)}s`
  return [run.error, duration, run.id].filter(Boolean).join(" · ")
}

/** Runs a manual Schedule Definition through the Console. Request failures become an `unavailable` result. */
export async function runConsoleScheduleDefinition(base: string, name: string): Promise<ConsoleScheduleRunView> {
  try {
    return parseConsoleScheduleRun(await requestConsole(base, { body: { name }, method: "POST" }))
  }
  catch (error) {
    return { error: error instanceof Error ? error.message : "The Schedule did not run.", status: "unavailable" }
  }
}
