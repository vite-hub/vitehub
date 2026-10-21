import { validateViteHubNitroDevRequest } from "@vite-hub/internal/dev-endpoint"
import { readViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { redactInspectionText } from "@vite-hub/internal/inspect"
import { isViteHubSecretEqual } from "@vite-hub/internal/secret"
import { runTask } from "nitro/task"

import { taskDevHeader, taskDevHeaderValue, taskDevTokenNamespace, taskDevTokenServerHeader } from "../../../task/dev.ts"

import type { TaskDevListResult, TaskDevRequestBody, TaskDevRunResult } from "../../../task/dev.ts"

/** Shape of the `tasks` export of Nitro's `#nitro/virtual/tasks` module. */
export type NitroTaskRegistry = Record<string, { meta?: { description?: string } }>

export interface TaskDevRequestOptions {
  /** Vite root. The private token file of each dev server is scoped to it. */
  rootDir: string
  tasks: NitroTaskRegistry
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" }, status })
}

function failure(code: string, message: string, status: number): Response {
  return json({ error: { code, message: redactInspectionText(message) } }, status)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object(value) === value && !Array.isArray(value)
}

async function readBody(request: Request): Promise<TaskDevRequestBody | undefined> {
  const body: unknown = await request.json().catch(() => undefined)
  if (!isRecord(body)) return
  if (body.operation === "list") return { operation: "list" }
  if (body.operation !== "run" || typeof body.name !== "string" || !body.name) return
  if (body.payload !== undefined && !isRecord(body.payload)) return
  return { name: body.name, operation: "run", payload: body.payload ?? {} }
}

function errorStatus(error: unknown): number | undefined {
  const status = isRecord(error) ? error.status : undefined
  return typeof status === "number" ? status : undefined
}

/**
 * Handles `vitehub task` requests inside the Nitro dev runtime. The task runs with Nitro's `runTask()`, so it uses the
 * same bindings, runtime config, and plugins as a request to the app.
 */
export async function handleTaskDevRequest(request: Request, options: TaskDevRequestOptions): Promise<Response> {
  const { rejection } = await validateViteHubNitroDevRequest(request, {
    // The token file exists only while its dev server runs, so a matching token proves the caller can read it.
    authorize: async (request) => {
      const serverId = request.headers.get(taskDevTokenServerHeader)
      const token = request.headers.get(viteHubDevTokenHeader)
      const expected = serverId && token
        ? await readViteHubDevToken(options.rootDir, { namespace: taskDevTokenNamespace, serverId })
        : undefined
      return expected && isViteHubSecretEqual(token, expected) ? undefined : new Response("Forbidden Task Dev token.", { status: 403 })
    },
    header: taskDevHeader,
    headerValue: taskDevHeaderValue,
    label: "Task Dev",
  })
  if (rejection) return rejection
  const body = await readBody(request)
  if (!body) return failure("TASK_DEV_INVALID_REQUEST", "The Task Dev request body is invalid.", 400)
  if (body.operation === "list") {
    const result: TaskDevListResult = {
      tasks: Object.entries(options.tasks)
        .map(([name, task]) => task.meta?.description ? { description: task.meta.description, name } : { name })
        .sort((left, right) => left.name.localeCompare(right.name)),
    }
    return json(result)
  }
  if (!Object.hasOwn(options.tasks, body.name)) {
    return failure("TASK_NOT_FOUND", `Task "${body.name}" does not exist. Run \`vitehub task list\` to see the registered tasks.`, 404)
  }
  const startedAt = performance.now()
  try {
    const output: unknown = await runTask(body.name, { context: {}, payload: body.payload })
    const result: TaskDevRunResult = { durationMs: Math.round(performance.now() - startedAt), name: body.name }
    if (isRecord(output) && output.result !== undefined) result.result = output.result
    return json(result)
  }
  catch (error) {
    // The dev server log keeps the stack. The CLI gets the message.
    console.error(`[vitehub] Task "${body.name}" failed.`, error)
    const message = error instanceof Error ? error.message : String(error)
    return errorStatus(error) === 501
      ? failure("TASK_NOT_IMPLEMENTED", message, 501)
      : failure("TASK_FAILED", `Task "${body.name}" failed: ${message}`, 500)
  }
}
