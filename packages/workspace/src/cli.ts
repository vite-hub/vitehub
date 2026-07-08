import {
  readWorkspaceDevToken,
  workspaceDevHeader,
  workspaceDevHeaderValue,
  workspaceDevRoute,
  workspaceDevTokenHeader,
} from "./server.ts"

import type { WorkspaceDevTokenOptions } from "./server.ts"

interface WorkspaceCliContext {
  cwd: string
  env: NodeJS.ProcessEnv
  rootDir: string
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface WorkspaceCliContributor {
  namespaces: Array<{
    description?: string
    features: Array<{
      description?: string
      name: string
      run: (args: string[], context: WorkspaceCliContext) => Promise<number | void> | number | void
      usage?: string
    }>
    name: string
  }>
}

interface ParsedWorkspaceDevArgs {
  args?: string[]
  command?: string
  help: boolean
  paths?: string[]
  timeout?: number
  url: string
  workspace?: string
}

interface WorkspaceDevCliOptions {
  fetch?: typeof fetch
}

interface WorkspaceDevDiscovery {
  root?: unknown
  workspaceDevTokenServerId?: unknown
  workspaces?: Array<{ name?: unknown }>
}

interface WorkspaceDevTarget {
  tokenOptions: WorkspaceDevTokenOptions
  url: string
}

interface WorkspaceDevProgressEvent {
  data?: Record<string, unknown>
  durationMs?: number
  error?: string
  id: string
  label: string
  status: "started" | "updating" | "completed" | "failed"
}

type WorkspaceDevStreamLine =
  | { event?: WorkspaceDevProgressEvent, type?: "progress" }
  | { result?: WorkspaceDevCommandResult, type?: "result" }
  | { error?: string, type?: "error" }

interface WorkspaceDevCommandResult {
  exitCode?: unknown
  stderr?: unknown
  stdout?: unknown
}

const workspaceCommandFeedbackIntervalMs = 15_000
const workspaceCommandStartedMessage = "[workspace] command started; first run may materialize sources.\n"
const workspaceCommandWaitingMessage = "[workspace] command still running; sources may still be materializing.\n"

function startWorkspaceCommandFeedback(context: WorkspaceCliContext): () => void {
  context.stderr.write(workspaceCommandStartedMessage)
  const timer = setInterval(() => context.stderr.write(workspaceCommandWaitingMessage), workspaceCommandFeedbackIntervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

function formatDurationMs(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`
}

function workspaceDevDataNumber(event: WorkspaceDevProgressEvent, key: string): number | undefined {
  const value = event.data?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function writeWorkspaceDevProgress(context: WorkspaceCliContext, event: WorkspaceDevProgressEvent): void {
  const duration = typeof event.durationMs === "number" ? ` (${formatDurationMs(event.durationMs)})` : ""
  if (event.status === "started") {
    context.stderr.write(`[workspace] ${event.label}...\n`)
    return
  }
  if (event.status === "updating") {
    const files = workspaceDevDataNumber(event, "files")
    const bytes = workspaceDevDataNumber(event, "bytes")
    const detail = files === undefined ? "" : `: ${files} file${files === 1 ? "" : "s"}${bytes === undefined ? "" : `, ${bytes} bytes`}`
    context.stderr.write(`[workspace] ${event.label}${detail}\n`)
    return
  }
  if (event.status === "failed") {
    context.stderr.write(`[workspace] ${event.label} failed${duration}${event.error ? `: ${event.error}` : ""}\n`)
    return
  }
  context.stderr.write(`[workspace] ${event.label} completed${duration}\n`)
}

function isWorkspaceDevStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("application/x-ndjson") === true
}

function handleWorkspaceDevStreamLine(line: string, context: WorkspaceCliContext): WorkspaceDevCommandResult | undefined {
  const parsed = JSON.parse(line) as WorkspaceDevStreamLine
  if (parsed.type === "progress" && parsed.event) {
    writeWorkspaceDevProgress(context, parsed.event)
    return
  }
  if (parsed.type === "error") {
    context.stderr.write(`${parsed.error || "Workspace Dev command failed."}\n`)
    return { exitCode: 1, stderr: "", stdout: "" }
  }
  if (parsed.type === "result") return parsed.result || {}
}

async function readWorkspaceDevStream(response: Response, context: WorkspaceCliContext): Promise<WorkspaceDevCommandResult> {
  const reader = response.body?.getReader()
  if (!reader) return {}
  const decoder = new TextDecoder()
  let buffer = ""
  let result: WorkspaceDevCommandResult | undefined
  for (;;) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) result = handleWorkspaceDevStreamLine(line, context) ?? result
      newline = buffer.indexOf("\n")
    }
    if (done) break
  }
  const line = buffer.trim()
  if (line) result = handleWorkspaceDevStreamLine(line, context) ?? result
  return result || {}
}

function writeWorkspaceDevUsage(context: WorkspaceCliContext): void {
  context.stdout.write([
    "Usage: vitehub workspace dev <workspace> [exec <command...>] [--url <url>] [--timeout <ms>]",
    "",
    "Run Workspace commands through a running Vite Development Server.",
    "Omit exec to open the interactive command loop.",
    "",
    "Options:",
    "  --url <url>       Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --timeout <ms>    Workspace command timeout.",
    "  --path <path>     Workspace path to materialize for command sessions. Repeatable.",
    "  -h, --help        Show this help.",
    "",
  ].join("\n"))
}

function readOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("-")) throw new Error(`Missing value for ${flag}.`)
  return value
}

function parseWorkspaceDevArgs(args: string[], env: NodeJS.ProcessEnv): ParsedWorkspaceDevArgs {
  const parsed: ParsedWorkspaceDevArgs = {
    help: false,
    url: env.VITEHUB_DEV_SERVER_URL || "http://localhost:5173",
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") {
      parsed.help = true
      continue
    }
    if (arg === "--url" || arg === "--server") {
      parsed.url = readOptionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg.startsWith("--url=")) {
      parsed.url = arg.slice("--url=".length)
      continue
    }
    if (arg === "--timeout") {
      const timeout = Number.parseInt(readOptionValue(args, index, arg), 10)
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("--timeout must be a positive number.")
      parsed.timeout = timeout
      index += 1
      continue
    }
    if (arg.startsWith("--timeout=")) {
      const timeout = Number.parseInt(arg.slice("--timeout=".length), 10)
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("--timeout must be a positive number.")
      parsed.timeout = timeout
      continue
    }
    if (arg === "--path") {
      parsed.paths ??= []
      parsed.paths.push(readOptionValue(args, index, arg))
      index += 1
      continue
    }
    if (arg.startsWith("--path=")) {
      parsed.paths ??= []
      parsed.paths.push(arg.slice("--path=".length))
      continue
    }
    if (arg.startsWith("-") && !parsed.workspace) throw new Error(`Unknown option: ${arg}.`)
    if (!parsed.workspace) {
      parsed.workspace = arg
      continue
    }
    if (arg === "exec") {
      const [command, ...commandArgs] = args.slice(index + 1)
      if (!command?.trim()) throw new Error("workspace dev exec requires a command.")
      parsed.command = command
      if (commandArgs.length) parsed.args = commandArgs
      break
    }
    throw new Error(`Unexpected argument: ${arg}. Use exec <command...> for one-shot commands.`)
  }
  return parsed
}

function endpointUrl(baseUrl: string): string {
  return new URL(workspaceDevRoute, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href
}

async function readWorkspaceDiscovery(parsed: ParsedWorkspaceDevArgs, context: WorkspaceCliContext, fetchImpl: typeof fetch): Promise<WorkspaceDevTarget | undefined> {
  if (!parsed.workspace) {
    context.stderr.write("Missing Workspace Dev target.\n")
    return
  }
  let url: string
  try {
    url = endpointUrl(parsed.url)
  }
  catch {
    context.stderr.write(`Invalid Vite Development Server URL: ${parsed.url}\n`)
    return
  }
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        [workspaceDevHeader]: workspaceDevHeaderValue,
      },
    })
  }
  catch {
    context.stderr.write(`No Compatible Vite Development Server found at ${parsed.url}.\n`)
    return
  }
  if (!response.ok) {
    context.stderr.write(`No Compatible Vite Development Server found at ${parsed.url}.\n`)
    return
  }
  const discovery = await response.json().catch(() => ({})) as WorkspaceDevDiscovery
  if (typeof discovery.root === "string" && discovery.root !== context.rootDir) {
    context.stderr.write(`Compatible Vite Development Server root mismatch: ${discovery.root}\n`)
    return
  }
  const workspaces = (discovery.workspaces || []).flatMap(workspace => typeof workspace.name === "string" ? [workspace.name] : [])
  if (!workspaces.includes(parsed.workspace)) {
    context.stderr.write(`Unknown Workspace Dev target: ${parsed.workspace}\n`)
    return
  }
  return {
    tokenOptions: typeof discovery.workspaceDevTokenServerId === "string" ? { serverId: discovery.workspaceDevTokenServerId } : {},
    url,
  }
}

async function sendWorkspaceCommand(
  target: WorkspaceDevTarget,
  parsed: ParsedWorkspaceDevArgs,
  context: WorkspaceCliContext,
  fetchImpl: typeof fetch,
): Promise<number> {
  if (!parsed.command) {
    context.stderr.write("Pass a command or run in an interactive terminal.\n")
    return 1
  }
  const token = await readWorkspaceDevToken(context.rootDir, target.tokenOptions)
  if (!token) {
    context.stderr.write("No private Workspace Dev token found. Start the Compatible Vite Development Server first.\n")
    return 1
  }
  const startedAt = Date.now()
  const stopFeedback = startWorkspaceCommandFeedback(context)
  try {
    const response = await fetchImpl(target.url, {
      body: JSON.stringify({
        workspaceCommand: {
          ...(parsed.args ? { args: parsed.args } : {}),
          command: parsed.command,
          ...(parsed.paths?.length ? { paths: parsed.paths } : {}),
          ...(parsed.timeout ? { timeout: parsed.timeout } : {}),
          workspace: parsed.workspace,
        },
      }),
      headers: {
        accept: "application/x-ndjson, application/json",
        "content-type": "application/json",
        [workspaceDevHeader]: workspaceDevHeaderValue,
        [workspaceDevTokenHeader]: token,
      },
      method: "POST",
    })
    if (!response.ok) {
      context.stderr.write(`${await response.text()}\n`)
      return 1
    }
    if (isWorkspaceDevStream(response)) stopFeedback()
    const result = isWorkspaceDevStream(response)
      ? await readWorkspaceDevStream(response, context)
      : await response.json().catch(() => ({})) as WorkspaceDevCommandResult
    if (typeof result.stdout === "string") context.stdout.write(result.stdout)
    if (typeof result.stderr === "string" && result.stderr) context.stderr.write(result.stderr)
    context.stderr.write(`[workspace] command completed (${formatDurationMs(Date.now() - startedAt)})\n`)
    return typeof result.exitCode === "number" ? result.exitCode : 0
  }
  finally {
    stopFeedback()
  }
}

async function runInteractiveWorkspaceDev(
  parsed: ParsedWorkspaceDevArgs,
  context: WorkspaceCliContext,
  fetchImpl: typeof fetch,
  target: WorkspaceDevTarget,
): Promise<number> {
  const { createInterface } = await import("node:readline/promises")
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  context.stdout.write(`Connected to ${parsed.workspace} at ${parsed.url}\n`)
  try {
    for (;;) {
      const command = (await readline.question("> ")).trim()
      if (!command) continue
      if (command === ".exit" || command === "exit") return 0
      const exitCode = await sendWorkspaceCommand(target, { ...parsed, command }, context, fetchImpl)
      if (exitCode !== 0) return exitCode
    }
  }
  finally {
    readline.close()
  }
}

export async function runWorkspaceDevCli(
  args: string[],
  context: WorkspaceCliContext,
  options: WorkspaceDevCliOptions = {},
): Promise<number> {
  let parsed: ParsedWorkspaceDevArgs
  try {
    parsed = parseWorkspaceDevArgs(args, context.env)
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    writeWorkspaceDevUsage(context)
    return 1
  }
  if (parsed.help) {
    writeWorkspaceDevUsage(context)
    return 0
  }
  const fetchImpl = options.fetch || globalThis.fetch
  const target = await readWorkspaceDiscovery(parsed, context, fetchImpl)
  if (!target) return 1
  if (parsed.command) return await sendWorkspaceCommand(target, parsed, context, fetchImpl)
  if (!process.stdin.isTTY) {
    context.stderr.write("Pass a command or run in an interactive terminal.\n")
    return 1
  }
  return await runInteractiveWorkspaceDev(parsed, context, fetchImpl, target)
}

export function createWorkspaceCliContributor(): WorkspaceCliContributor {
  return {
    namespaces: [{
      description: "Workspace development workflows.",
      features: [{
        description: "Run commands through a Workspace Session.",
        name: "dev",
        run: async (args, context) => await runWorkspaceDevCli(args, context),
        usage: "vitehub workspace dev <workspace> [exec <command...>]",
      }],
      name: "workspace",
    }],
  }
}
