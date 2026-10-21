import { hasViteHubDispatch, verifyViteHubDispatch } from "@vite-hub/internal/dispatch"
import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { defineGrant } from "@vite-hub/runtime/internal/grant"

import { getConsoleSchedules } from "./definitions.ts"
import { withConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { assertConsoleRequest, consoleRequestJSON, consoleRequestText } from "./request.ts"
import { getConsoleSections } from "./sections.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

import type { ScheduleRunRecord } from "@vite-hub/schedule"
import type { H3Event } from "h3"
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

async function runScheduleOperation(event: ConsoleRequestEvent): Promise<{ run: ConsoleScheduleRun }> {
  assertConsoleRequest(event, ["POST"])
  const outcome = await runConsoleSchedule(await consoleRequestJSON(event, maximumBodyBytes))
  if (outcome.ok) return { run: outcome.run }
  throw Object.assign(viteHubErrorDiagnostics.VITE_HUB_C0001({ message: outcome.message }), { statusCode: outcome.status, statusMessage: outcome.message })
}

/** Console RPC operation behind the Schedules page "Run now" button. */
export const consoleScheduleRunHandler: ConsoleAccessRoute<typeof runScheduleOperation> = withConsoleAccess(runScheduleOperation)

function failure(message: string, status: number): Response {
  return Response.json({ message }, { headers: responseHeaders, status })
}

/**
 * `POST /_vitehub/schedules/run` for `vitehub schedule run --url`.
 * The default export verifies a dispatch signature when the request has one, and checks Console access otherwise. A JSON body and a same-origin check keep browsers from sending cross-site runs.
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
    body = await consoleRequestJSON({ req: request }, maximumBodyBytes)
  }
  catch (error) {
    if (Reflect.get(Object(error), "statusCode") === 413) return failure("Schedule run request body is too large.", 413)
    return failure("Malformed Schedule run payload.", 400)
  }
  const outcome = await runConsoleSchedule(body)
  return outcome.ok
    ? Response.json({ run: outcome.run }, { headers: responseHeaders })
    : failure(outcome.message, outcome.status)
}

// Issued only after a dispatch signature matches. Bound to the parsed request body, so the run uses what was signed.
const scheduleDispatchGrant = defineGrant("vitehub.console.schedule-dispatch", (body: unknown) => body)

/** Runs the Schedule named by a verified dispatch body. The grant works once. */
async function runDispatchedSchedule(grant: ReturnType<typeof scheduleDispatchGrant.issue>): Promise<ConsoleScheduleRunOutcome> {
  return await runConsoleSchedule(scheduleDispatchGrant.consume(grant))
}

function processEnv(): Record<string, unknown> {
  return globalThis.process?.env ?? {}
}

/**
 * A signed `vitehub schedule run --url` request. The signature replaces Console access for this route only, and the
 * request never falls back to a Console session: a bad signature is always `401`. The actor claim is self-asserted.
 */
export async function handleDispatchScheduleRunRequest(request: Request, env: Record<string, unknown> = processEnv()): Promise<Response> {
  if (request.method !== "POST") return failure("Method not allowed.", 405)
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return failure("Schedule run requires application/json.", 415)
  const contentLength = request.headers.get("content-length")
  if (contentLength && Number.parseInt(contentLength, 10) > maximumBodyBytes) return failure("Schedule run request body is too large.", 413)
  let text = ""
  try {
    if (request.body) text = await consoleRequestText(request.body, maximumBodyBytes)
  }
  catch (error) {
    if (Reflect.get(Object(error), "statusCode") === 413) return failure("Schedule run request body is too large.", 413)
    return failure("Malformed Schedule run payload.", 400)
  }
  const verified = await verifyViteHubDispatch({ body: text, env, headers: request.headers, operation: "schedule.run" })
  if (!verified.ok) return failure(verified.message, verified.status)
  let body: unknown
  try {
    body = JSON.parse(text)
  }
  catch {
    return failure("Malformed Schedule run payload.", 400)
  }
  const grant = scheduleDispatchGrant.issue(body)
  const name: unknown = body instanceof Object && "name" in body ? body.name : undefined
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Schedule run requests are untrusted JSON.
  console.info(`[vitehub] Dispatch schedule.run ${typeof name === "string" ? name : "<invalid>"}${verified.actor ? ` by ${verified.actor} (self-asserted)` : ""}`)
  const outcome = await runDispatchedSchedule(grant)
  return outcome.ok
    ? Response.json({ run: outcome.run }, { headers: responseHeaders })
    : failure(outcome.message, outcome.status)
}

const consoleGuardedHandler: (event: H3Event) => Promise<Response> = withConsoleAccess((event: H3Event) => handleConsoleScheduleRunRequest(event.req), { section: "schedules" })
const guardedHandler = (event: H3Event): Promise<Response> => hasViteHubDispatch(event.req.headers)
  ? handleDispatchScheduleRunRequest(event.req, getCloudflareEnv(event, { fallback: false }))
  : consoleGuardedHandler(event)
export default guardedHandler
