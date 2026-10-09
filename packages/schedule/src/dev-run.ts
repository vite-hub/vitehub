import { StringDecoder } from "node:string_decoder"

import { redactInspectionText } from "@vite-hub/internal/inspect"
import { readViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { isViteHubSecretEqual } from "@vite-hub/internal/secret"

import { scheduleDevRunHeader, scheduleDevRunRoute, scheduleDevTokenNamespace, scheduleDevTokenServerHeader } from "./dev.ts"
import { runSchedule } from "./runtime/execute.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ViteDevServer } from "vite"
import type { ScheduleDefinitionRegistry, ScheduleRunRecord } from "./types.ts"

const maximumBodyBytes = 16 * 1_024
const maximumBodyErrorMessage = "Schedule run request body is too large."

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
  const decoder = new StringDecoder("utf8")
  for await (const chunk of req) {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Node's request stream permits string or byte chunks.
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > maximumBodyBytes) throw new RangeError(maximumBodyErrorMessage)
    body += decoder.write(buffer)
  }
  body += decoder.end()
  return JSON.parse(body)
}

function isScheduleRegistry(value: unknown): value is ScheduleDefinitionRegistry {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate untrusted boundary values before use.
  return value !== null && typeof value === "object" && Object.values(value).every(entry => typeof entry === "function")
}

/** JSON shape that the Development Server and the Console return for one manual run. */
export function scheduleRunResult(run: ScheduleRunRecord) {
  return {
    ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
    ...(run.error ? { error: { message: redactInspectionText(run.error.message), ...(run.error.name ? { name: redactInspectionText(run.error.name) } : {}) } } : {}),
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

async function handleScheduleDevRun(server: ViteDevServer, req: IncomingMessage, res: ServerResponse, serverId: string): Promise<void> {
  if (req.method === "GET" && header(req, scheduleDevRunHeader) === "1") return writeJSON(res, 200, { root: server.config.root, scheduleDevTokenServerId: serverId })
  // A custom header, a JSON body, and a same-origin check keep browsers from sending cross-site run requests.
  if (req.method !== "POST") return writeJSON(res, 405, { message: "Method not allowed." })
  if (header(req, scheduleDevRunHeader) !== "1") return writeJSON(res, 403, { message: "Forbidden Schedule run request." })
  const requestedServerId = header(req, scheduleDevTokenServerHeader)
  const token = header(req, viteHubDevTokenHeader)
  if (requestedServerId !== serverId || !isViteHubSecretEqual(token, await readViteHubDevToken(server.config.root, { namespace: scheduleDevTokenNamespace, serverId }))) return writeJSON(res, 403, { message: "Forbidden Schedule run token." })
  const origin = header(req, "origin")
  if (origin && (!URL.canParse(origin) || new URL(origin).host !== header(req, "host"))) return writeJSON(res, 403, { message: "Forbidden Schedule run origin." })
  if (!header(req, "content-type")?.toLowerCase().startsWith("application/json")) return writeJSON(res, 415, { message: "Schedule run requires application/json." })
  let body: unknown
  try {
    body = await readJSON(req)
  }
  catch (error) {
    if (error instanceof RangeError && error.message === maximumBodyErrorMessage) {
      return writeJSON(res, 413, { message: error.message })
    }
    return writeJSON(res, 400, { message: "Malformed Schedule run payload." })
  }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate untrusted boundary values before use.
  const name = body !== null && typeof body === "object" && "name" in body ? body.name : undefined
  if (typeof name !== "string" || !name) return writeJSON(res, 400, { message: "Schedule run requires a Schedule Definition name." })
  const registry = (await server.ssrLoadModule("#vitehub/schedule/registry")).default
  if (!isScheduleRegistry(registry)) return writeJSON(res, 500, { message: "The Schedule registry is invalid." })
  try {
    writeJSON(res, 200, { run: scheduleRunResult(await runSchedule(name, { registry })) })
  }
  catch (error) {
    writeJSON(res, scheduleRunErrorStatus(error), { message: redactInspectionText(error instanceof Error ? error.message : String(error)) })
  }
}

/** Serves `vitehub schedule run` without `--url` from the Vite Development Server. */
export function registerScheduleDevRunEndpoint(server: ViteDevServer, options: { serverId: string }): void {
  const configuredBase = new URL(server.config.base || "/", "http://localhost").pathname
  const baseRoute = configuredBase === "/"
    ? scheduleDevRunRoute
    : `${configuredBase.replace(/\/$/, "")}${scheduleDevRunRoute}`
  let closed = false
  server.httpServer?.once("close", () => { closed = true })
  server.middlewares.use((req, res, next) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname
    if (pathname !== scheduleDevRunRoute && pathname !== baseRoute) {
      next()
      return
    }
    if (closed) {
      writeJSON(res, 403, { message: "Forbidden Schedule run token." })
      return
    }
    handleScheduleDevRun(server, req, res, options.serverId).catch((error: unknown) => {
      if (!res.headersSent) writeJSON(res, 500, { message: error instanceof Error ? error.message : "Schedule run failed." })
    })
  })
}
