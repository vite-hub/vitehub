import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
} from "@vite-hub/internal/cli"

import { workflowDevRuntimeUnavailableCode } from "./dev-endpoint.ts"
import { workflowDevHeader, workflowDevHeaderValue, workflowDevOperations, workflowDevRoute } from "./dev-support.ts"
import { workflowErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliCommandNamespace, ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { WorkflowDevOperation, WorkflowDevRequest, WorkflowDevRunView, WorkflowDevSignalView } from "./dev-support.ts"

export type WorkflowCliContext = Pick<ViteHubCliContext, "cwd" | "env" | "rootDir"> & ViteHubCliStreams

export interface WorkflowCliOptions {
  fetch?: typeof fetch
}

export interface ParsedWorkflowCliArgs {
  help: boolean
  json: boolean
  operation: WorkflowDevOperation
  request?: WorkflowDevRequest
  timeout?: number
  url: string
}

const workflowDevEndpoint = {
  header: workflowDevHeader,
  headerValue: workflowDevHeaderValue,
  route: workflowDevRoute,
}

const workflowDevTargetErrors = {
  invalidInlineTimeout: (message: string) => workflowErrorDiagnostics.WORKFLOW_R0033({ message }),
  invalidTimeout: (message: string) => workflowErrorDiagnostics.WORKFLOW_R0032({ message }),
  missingValue: (message: string) => workflowErrorDiagnostics.WORKFLOW_R0031({ message }),
}

const workflowCliUsage: Record<WorkflowDevOperation, { description: string, options: string[], usage: string }> = {
  cancel: {
    description: "Cancel a Workflow run.",
    options: ["  --workflow <name>  Workflow name. Required for runs that `vitehub workflow start` did not start in the current Nitro dev runtime."],
    usage: "vitehub workflow cancel <runId> [--workflow <name>] [--json]",
  },
  get: {
    description: "Show the status and result of a Workflow run.",
    options: ["  --workflow <name>  Workflow name. Required for runs that `vitehub workflow start` did not start in the current Nitro dev runtime."],
    usage: "vitehub workflow get <runId> [--workflow <name>] [--json]",
  },
  resume: {
    description: "Resume a Workflow signal with its opaque token.",
    options: ["  --payload <json|@file>  Signal payload as JSON, or @path to a JSON file."],
    usage: "vitehub workflow resume <token> [--payload <json|@file>] [--json]",
  },
  start: {
    description: "Start a Workflow run.",
    options: ["  --input <json|@file>  Workflow input as JSON, or @path to a JSON file."],
    usage: "vitehub workflow start <name> [--input <json|@file>] [--json]",
  },
}

function writeWorkflowCliUsage(operation: WorkflowDevOperation, stream: ViteHubCliStreams["stdout"]): void {
  const command = workflowCliUsage[operation]
  stream.write([
    `Usage: ${command.usage}`,
    "",
    command.description,
    "The command runs in the Nitro dev runtime of a local Vite + Nitro Development Server. It does not reach deployed stages.",
    "",
    "Options:",
    ...command.options,
    "  --json             Print machine-readable JSON.",
    "  --url <url>        Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --timeout <ms>     Request timeout.",
    "  -h, --help         Show this help.",
    "",
  ].join("\n"))
}

interface PendingJsonValue {
  flag: string
  value: string
}

function readOptionValue(args: string[], index: number, flag: string, jsonValue = false): string {
  const value = args[index + 1]
  if (value === undefined || (value.startsWith("-") && value !== "-" && !(jsonValue && /^-\d/.test(value)))) {
    throw workflowErrorDiagnostics.WORKFLOW_R0031({ message: `Missing value for ${flag}.` })
  }
  return value
}

function readInlineOption(arg: string, flag: string): string | undefined {
  return arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : undefined
}

/**
 * Parses the arguments of one `vitehub workflow` command. JSON values stay
 * unparsed until {@link resolveWorkflowCliJsonValues} reads them.
 */
export function parseWorkflowCliArgs(operation: WorkflowDevOperation, args: string[], env: NodeJS.ProcessEnv): ParsedWorkflowCliArgs & { pendingJson?: PendingJsonValue } {
  const parsed: ParsedWorkflowCliArgs & { pendingJson?: PendingJsonValue } = {
    help: false,
    json: false,
    operation,
    url: resolveViteHubDevServerUrl(env),
  }
  const valueFlag = operation === "start" ? "--input" : operation === "resume" ? "--payload" : undefined
  const acceptsWorkflow = operation === "get" || operation === "cancel"
  let target: string | undefined
  let workflow: string | undefined

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
    const targetOption = readViteHubDevTargetOption(args, index, parsed, workflowDevTargetErrors)
    if (targetOption !== undefined) {
      index += targetOption
      continue
    }
    if (valueFlag && arg === valueFlag) {
      parsed.pendingJson = { flag: valueFlag, value: readOptionValue(args, index, arg, true) }
      index += 1
      continue
    }
    const inlineValue = valueFlag ? readInlineOption(arg, valueFlag) : undefined
    if (valueFlag && inlineValue !== undefined) {
      parsed.pendingJson = { flag: valueFlag, value: inlineValue }
      continue
    }
    if (acceptsWorkflow && arg === "--workflow") {
      workflow = readOptionValue(args, index, arg)
      index += 1
      continue
    }
    const inlineWorkflow = acceptsWorkflow ? readInlineOption(arg, "--workflow") : undefined
    if (inlineWorkflow !== undefined) {
      if (!inlineWorkflow) throw workflowErrorDiagnostics.WORKFLOW_R0031({ message: "Missing value for --workflow." })
      workflow = inlineWorkflow
      continue
    }
    if (operation === "resume" && (arg === "--signal" || arg.startsWith("--signal="))) {
      throw workflowErrorDiagnostics.WORKFLOW_R0034({ message: "Workflow signals resume by token, not by run ID and signal name. Use: vitehub workflow resume <token>." })
    }
    if (arg.startsWith("-")) throw workflowErrorDiagnostics.WORKFLOW_R0034({ message: `Unknown option: ${arg}.` })
    if (target !== undefined) throw workflowErrorDiagnostics.WORKFLOW_R0034({ message: `Unexpected argument: ${arg}.` })
    target = arg
  }

  if (parsed.help) return parsed
  if (!target) {
    const name = operation === "start" ? "Workflow name" : operation === "resume" ? "signal token" : "run ID"
    throw workflowErrorDiagnostics.WORKFLOW_R0034({ message: `Missing ${name}.` })
  }
  parsed.request = operation === "start"
    ? { operation, workflow: target }
    : operation === "resume"
      ? { operation, token: target }
      : { operation, runId: target, ...(workflow ? { workflow } : {}) }
  return parsed
}

async function readJsonOption(pending: PendingJsonValue, cwd: string): Promise<unknown> {
  let text = pending.value
  if (text.startsWith("@")) {
    const file = resolve(cwd, text.slice(1))
    try {
      text = await readFile(file, "utf8")
    }
    catch (error) {
      throw workflowErrorDiagnostics.WORKFLOW_R0035({ message: `Cannot read ${pending.flag} file ${text.slice(1)}: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  try {
    return JSON.parse(text)
  }
  catch (error) {
    throw workflowErrorDiagnostics.WORKFLOW_R0035({ message: `Invalid JSON for ${pending.flag}: ${error instanceof Error ? error.message : String(error)}` })
  }
}

/**
 * Reads `--input` or `--payload` as a JSON string or an `@file` path relative to `cwd`.
 */
export async function resolveWorkflowCliJsonValues(parsed: ParsedWorkflowCliArgs & { pendingJson?: PendingJsonValue }, cwd: string): Promise<ParsedWorkflowCliArgs> {
  const { pendingJson, ...rest } = parsed
  if (!pendingJson || !rest.request) return rest
  const value = await readJsonOption(pendingJson, cwd)
  if (rest.request.operation === "start") return { ...rest, request: { ...rest.request, input: value } }
  if (rest.request.operation === "resume") return { ...rest, request: { ...rest.request, payload: value } }
  return rest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isErrorBody(value: unknown): value is { error: { code?: unknown, message: string } } {
  return isRecord(value) && isRecord(value.error) && typeof value.error.message === "string"
}

function isProvider(value: unknown): value is WorkflowDevRunView["provider"] {
  return value === "cloudflare" || value === "openworkflow" || value === "vercel"
}

function isRunView(value: unknown): value is WorkflowDevRunView {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.workflow !== "string" || !isProvider(value.provider)) return false
  if (value.status !== "queued" && value.status !== "running" && value.status !== "completed"
    && value.status !== "failed" && value.status !== "cancelled" && value.status !== "unknown") return false
  for (const field of ["createdAt", "startedAt", "completedAt"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false
  }
  if (value.error !== undefined && (!isRecord(value.error) || typeof value.error.message !== "string"
    || (value.error.code !== undefined && typeof value.error.code !== "string")
    || (value.error.name !== undefined && typeof value.error.name !== "string"))) return false
  return true
}

function isSignalView(value: unknown): value is WorkflowDevSignalView {
  return isRecord(value) && typeof value.id === "string" && isProvider(value.provider)
}

class WorkflowCliFailure {
  constructor(readonly code: string, readonly message: string) {}
}

function writeFailure(parsed: Pick<ParsedWorkflowCliArgs, "json">, context: WorkflowCliContext, failure: WorkflowCliFailure): number {
  if (parsed.json) {
    context.stdout.write(`${JSON.stringify({ error: { code: failure.code, message: failure.message } }, null, 2)}\n`)
  }
  else {
    context.stderr.write(`${failure.message}\n`)
  }
  return 1
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

function writeRun(context: WorkflowCliContext, operation: WorkflowDevOperation, run: WorkflowDevRunView): void {
  if (operation === "start") {
    context.stdout.write(`Started run ${run.id} of workflow ${run.workflow} (${run.provider}, ${run.status}).\n`)
    context.stdout.write(`Check it with: vitehub workflow get ${run.id}\n`)
    return
  }
  if (operation === "cancel") {
    context.stdout.write(`Cancelled run ${run.id} of workflow ${run.workflow} (${run.provider}, ${run.status}).\n`)
    return
  }
  const lines = [
    `Run:       ${run.id}`,
    `Workflow:  ${run.workflow}`,
    `Provider:  ${run.provider}`,
    `Status:    ${run.status}${run.status === "unknown" ? " (the Nitro dev runtime has no record of this run)" : ""}`,
    ...(run.createdAt ? [`Created:   ${run.createdAt}`] : []),
    ...(run.startedAt ? [`Started:   ${run.startedAt}`] : []),
    ...(run.completedAt ? [`Completed: ${run.completedAt}`] : []),
    ...(run.error ? [`Error:     ${run.error.code ? `${run.error.code}: ` : ""}${run.error.message}`] : []),
    ...(run.result === undefined || run.result === null ? [] : [`Result:    ${formatValue(run.result)}`]),
  ]
  context.stdout.write(`${lines.join("\n")}\n`)
}

function writeSignal(context: WorkflowCliContext, signal: WorkflowDevSignalView): void {
  context.stdout.write(`Resumed signal for run ${signal.id} (${signal.provider}).\n`)
}

async function discoverWorkflowDevServer(parsed: ParsedWorkflowCliArgs, context: WorkflowCliContext, fetchImpl: typeof fetch) {
  const messages: string[] = []
  const server = await discoverViteHubDevServer({
    endpoint: workflowDevEndpoint,
    fetch: fetchImpl,
    rootDir: context.rootDir,
    serverUrl: parsed.url,
    stderr: { write: chunk => messages.push(String(chunk).trim()) },
  })
  if (!server) {
    throw new WorkflowCliFailure(
      "WORKFLOW_DEV_SERVER_NOT_FOUND",
      `${messages.join(" ") || `No Compatible Vite Development Server found at ${parsed.url}.`} Start the app with the Vite Development Server first.`,
    )
  }
  return server
}

function checkNitroRuntime(discovery: { root?: unknown, runtime?: unknown, message?: unknown }): void {
  if (discovery.runtime === "nitro") return
  throw new WorkflowCliFailure(
    workflowDevRuntimeUnavailableCode,
    typeof discovery.message === "string" ? discovery.message : "This Vite Development Server cannot reach the Workflow runtime.",
  )
}

async function sendWorkflowDevRequest(url: string, request: WorkflowDevRequest, parsed: ParsedWorkflowCliArgs, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response
  try {
    response = await fetchViteHubDevEndpoint(fetchImpl, url, workflowDevEndpoint, {
      body: JSON.stringify(request),
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      ...(parsed.timeout ? { signal: AbortSignal.timeout(parsed.timeout) } : {}),
    })
  }
  catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    throw new WorkflowCliFailure(
      timedOut ? "WORKFLOW_DEV_TIMEOUT" : "WORKFLOW_DEV_SERVER_NOT_FOUND",
      timedOut ? `workflow ${request.operation} timed out after ${parsed.timeout}ms.` : `No Compatible Vite Development Server found at ${parsed.url}.`,
    )
  }
  const text = await response.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  }
  catch {
    body = undefined
  }
  if (isErrorBody(body)) {
    throw new WorkflowCliFailure(typeof body.error.code === "string" ? body.error.code : "WORKFLOW_DEV_FAILED", body.error.message)
  }
  if (!response.ok || body === undefined) {
    throw new WorkflowCliFailure("WORKFLOW_DEV_FAILED", text.trim() || `Workflow Dev request failed with status ${response.status}.`)
  }
  return body
}

/**
 * Runs one `vitehub workflow <operation>` command in the Nitro dev runtime of a local Vite + Nitro Development Server.
 */
export async function runWorkflowCli(
  operation: WorkflowDevOperation,
  args: string[],
  context: WorkflowCliContext,
  options: WorkflowCliOptions = {},
): Promise<number> {
  let parsed: ParsedWorkflowCliArgs
  try {
    parsed = await resolveWorkflowCliJsonValues(parseWorkflowCliArgs(operation, args, context.env), context.cwd)
  }
  catch (error) {
    if (args.includes("--json")) return writeFailure({ json: true }, context, {
      code: "WORKFLOW_INVALID_ARGUMENT",
      message: error instanceof Error ? error.message : String(error),
    })
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    writeWorkflowCliUsage(operation, context.stderr)
    return 1
  }
  if (parsed.help || !parsed.request) {
    writeWorkflowCliUsage(operation, context.stdout)
    return 0
  }

  const fetchImpl = options.fetch || globalThis.fetch
  try {
    const { discovery, url } = await discoverWorkflowDevServer(parsed, context, fetchImpl)
    checkNitroRuntime(discovery)
    const body = await sendWorkflowDevRequest(url, parsed.request, parsed, fetchImpl)
    const run = isRecord(body) && isRunView(body.run) ? body.run : undefined
    const signal = isRecord(body) && isSignalView(body.signal) ? body.signal : undefined
    if (!run && !signal) throw new WorkflowCliFailure("WORKFLOW_DEV_FAILED", "Workflow Dev response has no run or signal.")
    if (parsed.json) {
      context.stdout.write(`${JSON.stringify(body, null, 2)}\n`)
      return 0
    }
    if (run) writeRun(context, operation, run)
    if (signal) writeSignal(context, signal)
    const note = isRecord(body) && typeof body.note === "string" ? body.note : undefined
    if (note) context.stderr.write(`[workflow] ${note}\n`)
    return 0
  }
  catch (error) {
    if (error instanceof WorkflowCliFailure) return writeFailure(parsed, context, error)
    throw error
  }
}

export function createWorkflowCliNamespace(options: WorkflowCliOptions = {}): ViteHubCliCommandNamespace {
  return {
    description: "Start and inspect Workflow runs in the Nitro dev runtime of a local Vite + Nitro Development Server.",
    features: workflowDevOperations.map(operation => ({
      description: workflowCliUsage[operation].description,
      name: operation,
      run: async (args: string[], context: WorkflowCliContext) => await runWorkflowCli(operation, args, context, options),
      usage: workflowCliUsage[operation].usage,
    })),
    name: "workflow",
  }
}

export function createWorkflowCliContributor(options: WorkflowCliOptions = {}): ViteHubCliContributor {
  return { namespaces: [createWorkflowCliNamespace(options)] }
}
