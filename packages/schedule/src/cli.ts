import { runScheduleRunCli } from "./cli-static.ts"
export { parseScheduleRunArgs, runScheduleRunCli } from "./cli-static.ts"
export { scheduleConsoleRunRoute } from "./dev.ts"

import {
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
} from "@vite-hub/internal/cli"

import { readViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { redactInspectionText } from "@vite-hub/internal/inspect"

import { scheduleDevHeader, scheduleDevHeaderValue, scheduleDevRoute, scheduleDevTokenNamespace, scheduleDevTokenServerHeader } from "./dev.ts"
import { scheduleErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { ScheduleDevOperation, ScheduleDevRequestBody } from "./dev.ts"
import type {
  ScheduleRunAttemptSummary,
  ScheduleRunSummary,
} from "./runtime/console.ts"

interface ScheduleDevDiscovery {
  message?: unknown
  root?: unknown
  runtime?: unknown
  scheduleDevTokenServerId?: unknown
}

export type ScheduleCliContext = Pick<ViteHubCliContext, "cwd" | "env" | "rootDir"> & ViteHubCliStreams

export interface ScheduleCliOptions {
  fetch?: typeof fetch
}

interface ScheduleCommand {
  description: string
  id: "schedule" | "run"
  limit?: boolean
  name: Exclude<ScheduleDevOperation, "run-static">
}

interface ParsedScheduleArgs {
  help: boolean
  id?: string
  json: boolean
  limit?: number
  timeout?: number
  url: string
}

const scheduleDevEndpoint = {
  header: scheduleDevHeader,
  headerValue: scheduleDevHeaderValue,
  route: scheduleDevRoute,
}

const scheduleDevTargetErrors = {
  invalidInlineTimeout: (message: string) => scheduleErrorDiagnostics.SCHEDULE_R0038({ message }),
  invalidTimeout: (message: string) => scheduleErrorDiagnostics.SCHEDULE_R0037({ message }),
  missingValue: (message: string) => scheduleErrorDiagnostics.SCHEDULE_R0036({ message }),
}

// Nuxt mounts Vite under `/_nuxt/`, so the Schedule dev endpoint is not reachable there.
const scheduleDevServerHint = "`vitehub schedule` needs a running Vite + Nitro Development Server with `schedule` enabled. Nuxt and plain Vite are not supported."

const scheduleCommands: readonly ScheduleCommand[] = [
  { description: "List the recorded runs of one Schedule Definition, newest first.", id: "schedule", limit: true, name: "runs" },
  { description: "List the attempts of one Schedule Run.", id: "run", name: "attempts" },
]

function commandUsage(command: ScheduleCommand): string {
  const id = command.id === "run" ? " <runId>" : " <name>"
  return `vitehub schedule ${command.name}${id}${command.limit ? " [--limit <n>]" : ""} [--json] [--url <url>]`
}

function writeUsage(command: ScheduleCommand, stream: ViteHubCliStreams["stdout"]): void {
  stream.write([
    `Usage: ${commandUsage(command)}`,
    "",
    command.description,
    "The command calls the Schedule runtime of a running Vite + Nitro Development Server.",
    "",
    "Options:",
    ...(command.limit ? ["  --limit <n>       Show at most n runs."] : []),
    "  --json            Print JSON.",
    "  --url <url>       Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --timeout <ms>    Request timeout, from 1 to 2147483647 whole milliseconds.",
    "  -h, --help        Show this help.",
    "  --                End options before an ID that starts with a hyphen.",
    "",
  ].join("\n"))
}

function parseLimit(value: string | undefined): number {
  const limit = Number(value)
  if (!value || !Number.isInteger(limit) || limit < 1) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0036({ message: "--limit must be a positive integer." })
  }
  return limit
}

function parseArgs(command: ScheduleCommand, args: readonly string[], env: NodeJS.ProcessEnv): ParsedScheduleArgs {
  const parsed: ParsedScheduleArgs = { help: false, json: false, url: resolveViteHubDevServerUrl(env) }
  let positionalOnly = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (!positionalOnly && arg === "--") {
      positionalOnly = true
      continue
    }
    if (positionalOnly) {
      if (parsed.id === undefined) {
        parsed.id = arg
        continue
      }
      throw scheduleErrorDiagnostics.SCHEDULE_R0036({ message: `Unexpected argument: ${arg}.` })
    }
    if (arg === "-h" || arg === "--help") {
      parsed.help = true
      continue
    }
    if (arg === "--json") {
      parsed.json = true
      continue
    }
    const targetOption = readViteHubDevTargetOption(args, index, parsed, scheduleDevTargetErrors)
    if (targetOption !== undefined) {
      index += targetOption
      continue
    }
    if (command.limit && arg === "--limit") {
      parsed.limit = parseLimit(args[index + 1])
      index += 1
      continue
    }
    if (command.limit && arg.startsWith("--limit=")) {
      parsed.limit = parseLimit(arg.slice("--limit=".length))
      continue
    }
    if (arg.startsWith("-")) throw scheduleErrorDiagnostics.SCHEDULE_R0036({ message: `Unknown option: ${arg}.` })
    if (parsed.id === undefined) {
      parsed.id = arg
      continue
    }
    throw scheduleErrorDiagnostics.SCHEDULE_R0036({ message: `Unexpected argument: ${arg}.` })
  }
  if (!parsed.help && !parsed.id) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0036({ message: command.id === "run" ? "Missing Schedule Run id." : "Missing Schedule Definition name." })
  }
  return parsed
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")).join("\n")
}

function formatRuns(runs: readonly ScheduleRunSummary[]): string {
  if (runs.length === 0) return "No runs.\n"
  return `${table([
    ["RUN", "STATUS", "SCHEDULED AT", "ATTEMPTS", "ERROR"],
    ...runs.map(run => [run.id, run.status, run.scheduledAt, String(run.attemptCount), run.error?.message ?? "-"]),
  ])}\n`
}

function formatAttempts(run: ScheduleRunSummary, attempts: readonly ScheduleRunAttemptSummary[]): string {
  const header = `Run: ${run.id} (${run.status})\n`
  if (attempts.length === 0) return `${header}No attempts.\n`
  return `${header}${table([
    ["ATTEMPT", "STATUS", "STARTED AT", "COMPLETED AT", "ERROR"],
    ...attempts.map(attempt => [attempt.id, attempt.status, attempt.startedAt, attempt.completedAt ?? "-", attempt.error?.message ?? "-"]),
  ])}\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringFields(value: Record<string, unknown>, fields: string[]): boolean {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
  return fields.every(field => typeof value[field] === "string")
}

function optionalStrings(value: Record<string, unknown>, fields: string[]): boolean {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
  return fields.every(field => value[field] === undefined || typeof value[field] === "string")
}

function isRunError(value: unknown): boolean {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
  return value === undefined || (isRecord(value) && typeof value.message === "string" && optionalStrings(value, ["name"]))
}

function isRunSummary(value: unknown): value is ScheduleRunSummary {
  // SAFETY: Every nested field is validated below before the untrusted response is treated as a ScheduleRunSummary.
  return isRecord(value) && stringFields(value, ["id", "scheduleId", "scheduledAt", "target"])
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
    && typeof value.attemptCount === "number" && Number.isInteger(value.attemptCount) && value.attemptCount >= 0
    && (value.status === "pending" || value.status === "running" || value.status === "succeeded" || value.status === "failed")
    && optionalStrings(value, ["completedAt", "startedAt"]) && isRunError(value.error)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
    && (value.response === undefined || (isRecord(value.response) && typeof value.response.status === "number"
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
      && Number.isInteger(value.response.status) && typeof value.response.statusText === "string"))
}

function isAttemptSummary(value: unknown): value is ScheduleRunAttemptSummary {
  return isRecord(value) && stringFields(value, ["id", "runId", "startedAt"])
    && (value.status === "running" || value.status === "succeeded" || value.status === "failed")
    && optionalStrings(value, ["completedAt"]) && isRunError(value.error)
}

function formatResult(operation: ScheduleCommand["name"], result: Record<string, unknown>): string | undefined {
  switch (operation) {
    case "runs":
      if (Array.isArray(result.runs) && result.runs.every(isRunSummary)) return formatRuns(result.runs)
      break
    case "attempts":
      if (isRunSummary(result.run) && Array.isArray(result.attempts) && result.attempts.every(isAttemptSummary)) return formatAttempts(result.run, result.attempts)
      break
  }
}

async function readFailure(response: Response): Promise<{ code?: string, message: string }> {
  const text = await response.text()
  try {
    const body: unknown = JSON.parse(text)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
      return { ...(typeof body.error.code === "string" ? { code: body.error.code } : {}), message: body.error.message }
    }
  }
  catch {
    // Guard rejections use plain text.
  }
  return { message: text || `Schedule Dev request failed with HTTP ${response.status}.` }
}

function writeFailure(parsed: Pick<ParsedScheduleArgs, "json">, context: ScheduleCliContext, failure: { code?: string, message: string }): number {
  const redacted = { ...failure, message: redactInspectionText(failure.message) }
  if (parsed.json) context.stdout.write(`${JSON.stringify({ error: redacted }, null, 2)}\n`)
  else context.stderr.write(`${redacted.message}\n`)
  return 1
}

function withTimeout(timeout: number | undefined): { signal?: AbortSignal } {
  return timeout ? { signal: AbortSignal.timeout(timeout) } : {}
}

async function runScheduleCommand(
  command: ScheduleCommand,
  args: string[],
  context: ScheduleCliContext,
  options: ScheduleCliOptions,
): Promise<number> {
  let parsed: ParsedScheduleArgs
  try {
    parsed = parseArgs(command, args, context.env)
  }
  catch (error) {
    const optionEnd = args.indexOf("--")
    if (args.slice(0, optionEnd === -1 ? args.length : optionEnd).includes("--json")) return writeFailure({ json: true }, context, { message: error instanceof Error ? error.message : String(error) })
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    writeUsage(command, context.stderr)
    return 1
  }
  if (parsed.help) {
    writeUsage(command, context.stdout)
    return 0
  }
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeout = withTimeout(parsed.timeout)
  let discoveryFailure = ""
  const server = await discoverViteHubDevServer<ScheduleDevDiscovery>({
    endpoint: scheduleDevEndpoint,
    fetch: fetchImpl,
    parseDiscovery: (value) => {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Discovery payloads are parsed at this transport boundary.
      if (!value || typeof value !== "object") return {}
      // SAFETY: The discovery parser has narrowed the untrusted response to an object before reading its fields.
      const record = value as Record<string, unknown>
      return { message: record.message, root: record.root, runtime: record.runtime, scheduleDevTokenServerId: record.scheduleDevTokenServerId }
    },
    rootDir: context.rootDir,
    serverUrl: parsed.url,
    stderr: { write: chunk => { discoveryFailure += String(chunk) } },
    ...timeout,
  })
  if (!server) return writeFailure(parsed, context, { message: `${discoveryFailure.trim()}\n${scheduleDevServerHint}` })
  if (server.discovery.runtime !== "nitro") {
    return writeFailure(parsed, context, {
      code: "SCHEDULE_DEV_RUNTIME_UNAVAILABLE",
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate primitive fields from the untrusted Schedule Dev response.
      message: typeof server.discovery.message === "string"
        ? server.discovery.message
        : "This Vite Development Server cannot reach the Schedule runtime.",
    })
  }
  const serverId = server.discovery.scheduleDevTokenServerId
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate public discovery metadata before selecting a local private credential.
  if (typeof serverId !== "string" || !serverId) return writeFailure(parsed, context, { message: "The Schedule Dev server did not provide a token server ID. Restart the Compatible Vite Development Server." })
  let token: string | undefined
  try {
    token = await readViteHubDevToken(context.rootDir, { namespace: scheduleDevTokenNamespace, serverId })
  }
  catch (error) {
    return writeFailure(parsed, context, { message: `Could not read the private Schedule Dev token: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (!token) return writeFailure(parsed, context, { message: "No private Schedule Dev token found. Start the Compatible Vite Development Server first." })
  const body: ScheduleDevRequestBody = {
    ...(parsed.id !== undefined ? { id: parsed.id } : {}),
    ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
    operation: command.name,
  }
  let response: Response
  try {
    response = await fetchViteHubDevEndpoint(fetchImpl, server.url, scheduleDevEndpoint, {
      body: JSON.stringify(body),
      headers: { accept: "application/json", "content-type": "application/json", [viteHubDevTokenHeader]: token, [scheduleDevTokenServerHeader]: serverId },
      method: "POST",
      ...timeout,
    })
    if (!response.ok) return writeFailure(parsed, context, await readFailure(response))
  }
  catch (error) {
    return writeFailure(parsed, context, { message: `Schedule Dev request failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  const result: unknown = await response.json().catch(() => undefined)
  if (!isRecord(result)) return writeFailure(parsed, context, { message: "The Schedule Dev response is not valid JSON." })
  const formatted = formatResult(command.name, result)
  if (formatted === undefined) return writeFailure(parsed, context, { message: "The Schedule Dev response has an invalid result shape." })
  context.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatted)
  return 0
}

/**
 * Runs one `vitehub schedule` command against a running Vite + Nitro Development Server.
 * `args[0]` is the command name, for example `runs` or `run`.
 */
export async function runScheduleCli(args: string[], context: ScheduleCliContext, options: ScheduleCliOptions = {}): Promise<number> {
  const [name, ...rest] = args
  if (name === "run") return await runScheduleRunCli(rest, context, options)
  const command = scheduleCommands.find(entry => entry.name === name)
  if (!command) {
    context.stderr.write(`${name ? `Unknown schedule command: ${name}\n` : ""}Commands: ${["run", ...scheduleCommands.map(entry => entry.name)].join(", ")}\n`)
    return 1
  }
  return await runScheduleCommand(command, rest, context, options)
}

export function createScheduleCliContributor(options: ScheduleCliOptions = {}): ViteHubCliContributor {
  return {
    namespaces: [{
      description: "Run Static Schedule Definitions and inspect their recorded runs.",
      features: [{ name: "run", description: "Run a Static Schedule Definition that sets manual: true.", usage: "vitehub schedule run <name> [--url <console-url>] [--server <dev-server-url>] [--json]", run: async (args: string[], context: ViteHubCliContext) => await runScheduleRunCli(args, context, options) }, ...scheduleCommands.map(command => ({
        description: command.description,
        name: command.name,
        run: async (args: string[], context: ViteHubCliContext) => await runScheduleCommand(command, args, context, options),
        usage: commandUsage(command),
      }))],
      name: "schedule",
    }],
  }
}
