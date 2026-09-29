import { scheduleDevRunHeader, scheduleDevRunRoute } from "./cli.ts"
import { runSchedule } from "./runtime/execute.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ViteDevServer } from "vite"
import type { ScheduleDefinitionRegistry, ScheduleRunRecord } from "./types.ts"

const maximumBodyBytes = 16 * 1_024

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function writeJSON(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader("cache-control", "no-store")
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(value))
}

async function readJSON(req: IncomingMessage): Promise<unknown> {
  let body = ""
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.byteLength
    if (bytes > maximumBodyBytes) throw new RangeError("Schedule run request body is too large.")
    body += buffer.toString("utf8")
  }
  return JSON.parse(body)
}

function isScheduleRegistry(value: unknown): value is ScheduleDefinitionRegistry {
  return value !== null && typeof value === "object" && Object.values(value).every(entry => typeof entry === "function")
}

/** JSON shape that the Development Server and the Console return for one manual run. */
export function scheduleRunResult(run: ScheduleRunRecord) {
  return {
    ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
    ...(run.error ? { error: { message: run.error.message, ...(run.error.name ? { name: run.error.name } : {}) } } : {}),
    id: run.id,
    scheduleId: run.scheduleId,
    ...(run.startedAt ? { startedAt: run.startedAt.toISOString() } : {}),
    status: run.status,
  }
}

/** HTTP status for a `runSchedule()` failure that happens before the handler starts. */
export function scheduleRunErrorStatus(error: unknown): number {
  const code = Reflect.get(Object(error), "code")
  return code === "SCHEDULE_DEFINITION_NOT_FOUND" ? 404 : code === "SCHEDULE_MANUAL_RUN_DISABLED" ? 403 : 500
}

async function handleScheduleDevRun(server: ViteDevServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // A custom header, a JSON body, and a same-origin check keep browsers from sending cross-site run requests.
  if (req.method !== "POST") return writeJSON(res, 405, { message: "Method not allowed." })
  if (header(req, scheduleDevRunHeader) !== "1") return writeJSON(res, 403, { message: "Forbidden Schedule run request." })
  const origin = header(req, "origin")
  if (origin && URL.canParse(origin) && new URL(origin).host !== header(req, "host")) return writeJSON(res, 403, { message: "Forbidden Schedule run origin." })
  if (!header(req, "content-type")?.toLowerCase().startsWith("application/json")) return writeJSON(res, 415, { message: "Schedule run requires application/json." })
  let body: unknown
  try {
    body = await readJSON(req)
  }
  catch {
    return writeJSON(res, 400, { message: "Malformed Schedule run payload." })
  }
  const name = body !== null && typeof body === "object" && "name" in body ? body.name : undefined
  if (typeof name !== "string" || !name) return writeJSON(res, 400, { message: "Schedule run requires a Schedule Definition name." })
  const registry = (await server.ssrLoadModule("#vitehub/schedule/registry")).default
  if (!isScheduleRegistry(registry)) return writeJSON(res, 500, { message: "The Schedule registry is invalid." })
  try {
    writeJSON(res, 200, { run: scheduleRunResult(await runSchedule(name, { registry })) })
  }
  catch (error) {
    writeJSON(res, scheduleRunErrorStatus(error), { message: error instanceof Error ? error.message : String(error) })
  }
}

/** Serves `vitehub schedule run` without `--url` from the Vite Development Server. */
export function registerScheduleDevRunEndpoint(server: ViteDevServer): void {
  server.middlewares.use((req, res, next) => {
    if (new URL(req.url || "/", "http://localhost").pathname !== scheduleDevRunRoute) {
      next()
      return
    }
    handleScheduleDevRun(server, req, res).catch((error: unknown) => {
      if (!res.headersSent) writeJSON(res, 500, { message: error instanceof Error ? error.message : "Schedule run failed." })
    })
  })
}
