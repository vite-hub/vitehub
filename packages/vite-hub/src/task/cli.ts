import {
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
} from "@vite-hub/internal/cli"
import { readViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { redactInspectionText } from "@vite-hub/internal/inspect"

import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"
import { taskDevHeader, taskDevHeaderValue, taskDevRoute, taskDevTokenNamespace, taskDevTokenServerHeader } from "./dev.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { TaskDevListResult, TaskDevRequestBody, TaskDevRunResult } from "./dev.ts"

export type TaskCliContext = Pick<ViteHubCliContext, "env" | "rootDir"> & ViteHubCliStreams

export interface TaskCliOptions {
  fetch?: typeof fetch
}

interface ParsedTaskArgs {
  help: boolean
  json: boolean
  name?: string
  payload: Record<string, unknown>
  timeout?: number
  url: string
}

interface TaskFailure {
  code?: string
  message: string
}

type TaskDevOutcome = { failure: TaskFailure, ok: false } | { ok: true, result: unknown }

const taskDevEndpoint = { header: taskDevHeader, headerValue: taskDevHeaderValue, route: taskDevRoute }

const argumentError = (message: string) => viteHubErrorDiagnostics.VITE_HUB_R0134({ message })
const taskDevTargetErrors = { invalidInlineTimeout: argumentError, invalidTimeout: argumentError, missingValue: argumentError }

const taskDevServerHint = "`vitehub task` needs a running Vite + Nitro Development Server. Start the app with `vite dev`, then run the command from another terminal."

const listUsage = "vitehub task list [--json] [--url <url>] [--timeout <ms>]"
const runUsage = "vitehub task run <name> [--<key> <value>]... [--payload <json>] [--json] [--url <url>] [--timeout <ms>]"

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object(value) === value && !Array.isArray(value)
}

function writeUsage(operation: TaskDevRequestBody["operation"], stream: ViteHubCliStreams["stdout"]): void {
  stream.write([
    `Usage: ${operation === "list" ? listUsage : runUsage}`,
    "",
    operation === "list"
      ? "Lists the Nitro tasks that the running app registers, for example the files in server/tasks/."
      : "Runs one Nitro task in the running app, with the same bindings as a request.",
    "",
    "Options:",
    ...(operation === "run"
      ? [
          "  --<key> <value>   Set payload.<key> to a string. A flag without a value sets it to true.",
          "  --payload <json>  Payload JSON object. --<key> options replace its keys.",
        ]
      : []),
    "  --json            Print JSON.",
    "  --url <url>       Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --timeout <ms>    Request timeout, from 1 to 2147483647 whole milliseconds.",
    "  -h, --help        Show this help.",
    "",
  ].join("\n"))
}

function parsePayloadJson(value: string | undefined): Record<string, unknown> {
  let payload: unknown
  try {
    payload = JSON.parse(value ?? "")
  }
  catch {
    throw argumentError("--payload must be a JSON object.")
  }
  if (!isRecord(payload)) throw argumentError("--payload must be a JSON object.")
  return payload
}

/** Reads `--key value`, `--key=value`, and `--flag` into the task payload. */
function parseArgs(operation: TaskDevRequestBody["operation"], args: readonly string[], env: NodeJS.ProcessEnv): ParsedTaskArgs {
  const parsed: ParsedTaskArgs = { help: false, json: false, payload: {}, url: resolveViteHubDevServerUrl(env) }
  const options: Record<string, unknown> = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") {
      parsed.help = true
      continue
    }
    if (arg === "--json") {
      parsed.json = true
      continue
    }
    const targetOption = readViteHubDevTargetOption(args, index, parsed, taskDevTargetErrors)
    if (targetOption !== undefined) {
      index += targetOption
      continue
    }
    if (operation === "run" && (arg === "--payload" || arg.startsWith("--payload="))) {
      const inline = arg.startsWith("--payload=")
      parsed.payload = parsePayloadJson(inline ? arg.slice("--payload=".length) : args[index + 1])
      if (!inline) index += 1
      continue
    }
    if (operation === "run" && arg.startsWith("--") && arg.length > 2) {
      const equals = arg.indexOf("=")
      if (equals > 2) {
        options[arg.slice(2, equals)] = arg.slice(equals + 1)
        continue
      }
      const next = args[index + 1]
      if (next === undefined || next.startsWith("--")) {
        options[arg.slice(2)] = true
        continue
      }
      options[arg.slice(2)] = next
      index += 1
      continue
    }
    if (operation === "run" && parsed.name === undefined && !arg.startsWith("-")) {
      parsed.name = arg
      continue
    }
    throw argumentError(`Unexpected argument: ${arg}.`)
  }
  parsed.payload = { ...parsed.payload, ...options }
  if (operation === "run" && !parsed.help && !parsed.name) throw argumentError("Missing task name.")
  return parsed
}

function formatList(result: TaskDevListResult): string {
  if (!result.tasks.length) return "No tasks. Add a file to server/tasks/, for example server/tasks/seed.ts.\n"
  const width = Math.max(4, ...result.tasks.map(task => task.name.length)) + 2
  return [
    `${"NAME".padEnd(width)}DESCRIPTION`,
    ...result.tasks.map(task => `${task.name.padEnd(width)}${task.description ?? ""}`.trimEnd()),
    "",
  ].join("\n")
}

function formatRun(result: TaskDevRunResult): string {
  const lines = [`Task ${result.name} finished in ${result.durationMs} ms.`]
  if (result.result !== undefined) {
    lines.push(typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2))
  }
  return `${lines.join("\n")}\n`
}

function isListResult(value: unknown): value is TaskDevListResult {
  return isRecord(value) && Array.isArray(value.tasks) && value.tasks.every(task => isRecord(task) && typeof task.name === "string"
    && (task.description === undefined || typeof task.description === "string"))
}

function isRunResult(value: unknown): value is TaskDevRunResult {
  return isRecord(value) && typeof value.name === "string" && typeof value.durationMs === "number"
}

async function readFailure(response: Response): Promise<TaskFailure> {
  const text = await response.text()
  try {
    const body: unknown = JSON.parse(text)
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
      return { ...(typeof body.error.code === "string" ? { code: body.error.code } : {}), message: body.error.message }
    }
  }
  catch {
    // Guard rejections use plain text.
  }
  return { message: text || `Task Dev request failed with HTTP ${response.status}.` }
}

function writeFailure(json: boolean, context: TaskCliContext, failure: TaskFailure): number {
  const redacted = { ...failure, message: redactInspectionText(failure.message) }
  if (json) context.stdout.write(`${JSON.stringify({ error: redacted }, null, 2)}\n`)
  else context.stderr.write(`${redacted.message}\n`)
  return 1
}

async function requestTaskDev(body: TaskDevRequestBody, parsed: ParsedTaskArgs, context: TaskCliContext, fetchImpl: typeof fetch): Promise<TaskDevOutcome> {
  const signal = parsed.timeout ? { signal: AbortSignal.timeout(parsed.timeout) } : {}
  let discoveryFailure = ""
  const server = await discoverViteHubDevServer<{ message?: unknown, root?: unknown, runtime?: unknown, taskDevTokenServerId?: unknown }>({
    endpoint: taskDevEndpoint,
    fetch: fetchImpl,
    parseDiscovery: value => isRecord(value)
      ? { message: value.message, root: value.root, runtime: value.runtime, taskDevTokenServerId: value.taskDevTokenServerId }
      : {},
    rootDir: context.rootDir,
    serverUrl: parsed.url,
    stderr: { write: (chunk) => { discoveryFailure += String(chunk) } },
    ...signal,
  })
  const fail = (failure: TaskFailure): TaskDevOutcome => ({ failure, ok: false })
  if (!server) return fail({ message: `${discoveryFailure.trim()}\n${taskDevServerHint}` })
  if (server.discovery.runtime !== "nitro") {
    return fail({
      code: "TASK_DEV_RUNTIME_UNAVAILABLE",
      message: typeof server.discovery.message === "string" ? server.discovery.message : "This Vite Development Server cannot run Nitro tasks.",
    })
  }
  const serverId = server.discovery.taskDevTokenServerId
  if (typeof serverId !== "string" || !serverId) return fail({ message: "The Task Dev server did not provide a token server ID. Restart the Vite Development Server." })
  const token = await readViteHubDevToken(context.rootDir, { namespace: taskDevTokenNamespace, serverId })
  if (!token) return fail({ message: "No private Task Dev token found. Restart the Vite Development Server." })
  const response = await fetchViteHubDevEndpoint(fetchImpl, server.url, taskDevEndpoint, {
    body: JSON.stringify(body),
    headers: { "accept": "application/json", "content-type": "application/json", [viteHubDevTokenHeader]: token, [taskDevTokenServerHeader]: serverId },
    method: "POST",
    ...signal,
  })
  if (!response.ok) return fail(await readFailure(response))
  return { ok: true, result: await response.json().catch(() => undefined) }
}

/**
 * Runs `vitehub task list` or `vitehub task run` against a running Vite + Nitro Development Server.
 */
export async function runTaskCli(operation: TaskDevRequestBody["operation"], args: string[], context: TaskCliContext, options: TaskCliOptions = {}): Promise<number> {
  let parsed: ParsedTaskArgs
  try {
    parsed = parseArgs(operation, args, context.env)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (args.includes("--json")) return writeFailure(true, context, { message })
    context.stderr.write(`${message}\n`)
    writeUsage(operation, context.stderr)
    return 1
  }
  if (parsed.help) {
    writeUsage(operation, context.stdout)
    return 0
  }
  const body: TaskDevRequestBody = operation === "list" ? { operation } : { name: parsed.name!, operation, payload: parsed.payload }
  let outcome: TaskDevOutcome
  try {
    outcome = await requestTaskDev(body, parsed, context, options.fetch ?? globalThis.fetch)
  }
  catch (error) {
    return writeFailure(parsed.json, context, { message: `Task Dev request failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (!outcome.ok) return writeFailure(parsed.json, context, outcome.failure)
  const result = outcome.result
  const formatted = operation === "list"
    ? isListResult(result) ? formatList(result) : undefined
    : isRunResult(result) ? formatRun(result) : undefined
  if (formatted === undefined) return writeFailure(parsed.json, context, { message: "The Task Dev response has an invalid shape." })
  context.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatted)
  return 0
}

export function createTaskCliContributor(options: TaskCliOptions = {}): ViteHubCliContributor {
  return {
    namespaces: [{
      description: "List and run Nitro tasks, such as server/tasks/seed.ts, in the running app.",
      features: [
        { description: "List the tasks that the running app registers.", name: "list", run: async (args, context) => await runTaskCli("list", args, context, options), usage: listUsage },
        { description: "Run one task with the app's bindings, for example a seed or a backfill.", name: "run", run: async (args, context) => await runTaskCli("run", args, context, options), usage: runUsage },
      ],
      name: "task",
    }],
  }
}
