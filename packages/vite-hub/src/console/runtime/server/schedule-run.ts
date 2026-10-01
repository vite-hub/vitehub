import { fromWebHandler } from "h3"

import { getConsoleSchedules } from "./definitions.ts"
import { assertConsoleRequest, consoleRequestJSON } from "./request.ts"
import { getConsoleSections } from "./sections.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

import type { ScheduleRunRecord } from "@vite-hub/schedule"
import type { EventHandler } from "h3"
import type { ConsoleRequestEvent } from "./request.ts"

export interface ConsoleScheduleRun {
  completedAt?: string
  error?: { message: string, name?: string }
  id: string
  scheduleId: string
  startedAt?: string
  status: ScheduleRunRecord["status"]
}

type ConsoleScheduleRunOutcome = { ok: true, run: ConsoleScheduleRun } | { message: string, ok: false, status: number }

const maximumBodyBytes = 16 * 1_024
const responseHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" }

function consoleScheduleRun(run: ScheduleRunRecord): ConsoleScheduleRun {
  return {
    ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
    // The Console omits the stack so a run result does not expose server file paths.
    ...(run.error ? { error: { message: run.error.message, ...(run.error.name ? { name: run.error.name } : {}) } } : {}),
    id: run.id,
    scheduleId: run.scheduleId,
    ...(run.startedAt ? { startedAt: run.startedAt.toISOString() } : {}),
    status: run.status,
  }
}

/**
 * Runs a manual Static Schedule Definition for the Console and `vitehub schedule run --url`.
 * The registry holds only `manual: true` definitions, and it is empty unless Console invocation is enabled.
 */
export async function runConsoleSchedule(body: unknown): Promise<ConsoleScheduleRunOutcome> {
  const name: unknown = body instanceof Object && "name" in body ? body.name : undefined
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Schedule run requests are untrusted JSON.
  if (typeof name !== "string" || !name) return { message: "Schedule run requires a Schedule Definition name.", ok: false, status: 400 }
  const registry = getConsoleSections().includes("schedules") ? getConsoleSchedules() : {}
  if (!Object.hasOwn(registry, name)) {
    return { message: "Schedule run is not available. Set manual: true on the Schedule Definition and enable Console invocation.", ok: false, status: 404 }
  }
  const { runSchedule } = await import("@vite-hub/schedule/runtime")
  try {
    return { ok: true, run: consoleScheduleRun(await runSchedule(name, { registry })) }
  }
  catch (error) {
    const code = Reflect.get(Object(error), "code")
    const status = code === "SCHEDULE_DEFINITION_NOT_FOUND" ? 404 : code === "SCHEDULE_MANUAL_RUN_DISABLED" ? 403 : 500
    return { message: error instanceof Error ? error.message : "Schedule run failed.", ok: false, status }
  }
}

/** Console RPC operation behind the Schedules page "Run now" button. */
export async function consoleScheduleRunHandler(event: ConsoleRequestEvent): Promise<{ run: ConsoleScheduleRun }> {
  assertConsoleRequest(event, ["POST"])
  const outcome = await runConsoleSchedule(await consoleRequestJSON(event, maximumBodyBytes))
  if (outcome.ok) return { run: outcome.run }
  throw Object.assign(viteHubErrorDiagnostics.VITE_HUB_C0001({ message: outcome.message }), { statusCode: outcome.status, statusMessage: outcome.message })
}

function failure(message: string, status: number): Response {
  return Response.json({ message }, { headers: responseHeaders, status })
}

/**
 * `POST /_vitehub/schedules/run` for `vitehub schedule run --url`.
 * Console access protects `/_vitehub/**`. A JSON body and a same-origin check keep browsers from sending cross-site runs.
 */
export async function handleConsoleScheduleRunRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") return failure("Method not allowed.", 405)
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return failure("Schedule run requires application/json.", 415)
  const origin = request.headers.get("origin")
  if (origin && origin !== new URL(request.url).origin) return failure("Schedule run origin is not allowed.", 403)
  let body: unknown
  try {
    const contentLength = request.headers.get("content-length")
    if (contentLength && Number.parseInt(contentLength, 10) > maximumBodyBytes) return failure("Schedule run request body is too large.", 413)
    const reader = request.body?.getReader()
    if (!reader) return failure("Malformed Schedule run payload.", 400)
    const decoder = new TextDecoder()
    let text = ""
    let bytes = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        text += decoder.decode()
        break
      }
      bytes += chunk.value.byteLength
      if (bytes > maximumBodyBytes) {
        await reader.cancel()
        return failure("Schedule run request body is too large.", 413)
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    body = JSON.parse(text)
  }
  catch {
    return failure("Malformed Schedule run payload.", 400)
  }
  const outcome = await runConsoleSchedule(body)
  return outcome.ok
    ? Response.json({ run: outcome.run }, { headers: responseHeaders })
    : failure(outcome.message, outcome.status)
}

const handler: EventHandler = fromWebHandler(handleConsoleScheduleRunRequest)
export default handler
