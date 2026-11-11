import { hasViteHubDispatch, verifyViteHubDispatch } from "@vite-hub/internal/dispatch"
import { getStandardContext } from "@vite-hub/runtime/h3"
import { defineGrant } from "@vite-hub/runtime/internal/grant"

import { withConsoleAccess, type ConsoleAccess } from "./access.ts"
import { isConsoleCrossOriginCall, withConsoleCors } from "./cors.ts"
import { getConsoleSchedules } from "./definitions.ts"
import { consoleRequestText, consoleRequestURL, consoleRoute } from "./request.ts"
import { loadConsoleRuntime } from "./runtime.ts"
import { getConsoleSections } from "./sections.ts"

import type { ScheduleRunRecord } from "@vite-hub/schedule"
import type { ConsoleRequestEvent, ConsoleRoute } from "./request.ts"

export interface ConsoleScheduleRun {
  completedAt?: string
  error?: { message: string, name?: string }
  id: string
  scheduleId: string
  /** The fire time that the handler received. */
  scheduledAt: string
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
    scheduledAt: run.scheduledAt.toISOString(),
    ...(run.startedAt ? { startedAt: run.startedAt.toISOString() } : {}),
    status: run.status,
  }
}

/**
 * Runs a manual Static Schedule Definition for a signed dispatch.
 * The registry holds only `manual: true` definitions, and it is empty unless Console invocation is enabled.
 */
export async function runConsoleSchedule(body: unknown): Promise<ConsoleScheduleRunOutcome> {
  const name: unknown = body instanceof Object && "name" in body ? body.name : undefined
  if (typeof name !== "string" || !name) return { message: "Schedule run requires a Schedule Definition name.", ok: false, status: 400 }
  const at: unknown = body instanceof Object && "at" in body ? body.at : undefined
  if (at !== undefined && typeof at !== "string") return { message: "Schedule run `at` must be an ISO 8601 date-time string.", ok: false, status: 400 }
  await loadConsoleRuntime()
  const registry = getConsoleSections().includes("schedules") ? getConsoleSchedules() : {}
  if (!Object.hasOwn(registry, name)) {
    return { message: "Schedule run is not available. Set manual: true on the Schedule Definition and enable Console invocation.", ok: false, status: 404 }
  }
  const { runSchedule } = await import("@vite-hub/schedule/runtime")
  try {
    return { ok: true, run: consoleScheduleRun(await runSchedule(name, { registry, scheduledAt: at })) }
  }
  catch (error) {
    const code = Reflect.get(Object(error), "code")
    const status = code === "SCHEDULE_DEFINITION_NOT_FOUND" ? 404 : code === "SCHEDULE_MANUAL_RUN_DISABLED" ? 403 : code === "SCHEDULE_INVALID_SCHEDULED_AT" ? 400 : 500
    return { message: error instanceof Error ? error.message : "Schedule run failed.", ok: false, status }
  }
}

function failure(message: string, status: number): Response {
  return Response.json({ message }, { headers: responseHeaders, status })
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

async function readScheduleRunBody(request: Request): Promise<{ ok: true, text: string } | { ok: false, response: Response }> {
  if (request.method !== "POST") return { ok: false, response: failure("Method not allowed.", 405) }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return { ok: false, response: failure("Schedule run requires application/json.", 415) }
  const contentLength = request.headers.get("content-length")
  if (contentLength && Number.parseInt(contentLength, 10) > maximumBodyBytes) return { ok: false, response: failure("Schedule run request body is too large.", 413) }
  try {
    return { ok: true, text: request.body ? await consoleRequestText(request.body, maximumBodyBytes) : "" }
  }
  catch (error) {
    if (Reflect.get(Object(error), "statusCode") === 413) return { ok: false, response: failure("Schedule run request body is too large.", 413) }
    return { ok: false, response: failure("Malformed Schedule run payload.", 400) }
  }
}

/**
 * A signed `vitehub schedule run --url` request. The signature replaces Console access for this route only, and the
 * request never falls back to a Console session: a bad signature is always `401`. The actor claim is self-asserted.
 */
export async function handleDispatchScheduleRunRequest(request: Request, env: Record<string, unknown> = processEnv()): Promise<Response> {
  const read = await readScheduleRunBody(request)
  if (!read.ok) return read.response
  const text = read.text
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
  console.info(`[vitehub] Dispatch schedule.run ${typeof name === "string" ? name : "<invalid>"}${verified.actor ? ` by ${verified.actor} (self-asserted)` : ""}`)
  const outcome = await runDispatchedSchedule(grant)
  return outcome.ok
    ? Response.json({ run: outcome.run }, { headers: responseHeaders })
    : failure(outcome.message, outcome.status)
}

const unsignedRunMessage = "This route takes signed dispatches only, or the Console token as Authorization: Bearer with console: { auth: \"token\" }. Sign the request with VITEHUB_DISPATCH_KEY (`vitehub secret derive vitehub:dispatch` prints it), or run the Schedule through the Console RPC with Console credentials. `vitehub schedule run <name> --url <origin>` does either."

/**
 * A Schedule run with the Console token: `Authorization: Bearer` with `auth: "token"`. The Console access check decides,
 * with a full `schedules` grant. A cookie or a session never runs a Schedule here; it uses the `schedule.run` operation.
 * A JSON content type and the origin check keep other sites out, as in Channel replay. A listed origin of
 * `console.origins` may call it with the verified token.
 */
async function runScheduleWithConsoleAccess(event: ConsoleRequestEvent, access: ConsoleAccess): Promise<Response> {
  // Only the token mode verifies a bearer token on this route. Another mode would accept the session next to it.
  if (access.mode !== "token") return failure(unsignedRunMessage, 401)
  const request = getStandardContext(event).req
  const origin = request.headers.get("origin")
  if (origin && origin !== consoleRequestURL(event).origin && !isConsoleCrossOriginCall(request, access)) {
    return failure("Schedule run origin is not allowed.", 403)
  }
  const read = await readScheduleRunBody(request)
  if (!read.ok) return read.response
  let body: unknown
  try {
    body = JSON.parse(read.text)
  }
  catch {
    return failure("Malformed Schedule run payload.", 400)
  }
  const outcome = await runConsoleSchedule(body)
  return outcome.ok
    ? Response.json({ run: outcome.run }, { headers: responseHeaders })
    : failure(outcome.message, outcome.status)
}

const consoleScheduleRunHandler: (event: ConsoleRequestEvent) => Promise<Response> = withConsoleCors(withConsoleAccess(runScheduleWithConsoleAccess, { section: "schedules", write: true }))

const unsignedScheduleRunHandler: (event: ConsoleRequestEvent) => Promise<Response> = withConsoleCors(async () => failure(unsignedRunMessage, 401))

/**
 * A signed dispatch is its own authority and never falls back to Console access. A request with `Authorization: Bearer`
 * goes through the Console access check, as every Console data route does. Any other request gets `401`.
 * `POST <base>/_vitehub/schedules/run`
 */
const scheduleRunRoute: ConsoleRoute = consoleRoute(async (event) => {
  const { req: request, runtime } = getStandardContext(event)
  if (hasViteHubDispatch(request.headers)) return await handleDispatchScheduleRunRequest(request, runtime?.cloudflare?.env)
  return /^Bearer\s+\S+/i.test(request.headers.get("authorization") ?? "") ? await consoleScheduleRunHandler(event) : await unsignedScheduleRunHandler(event)
})
export default scheduleRunRoute
