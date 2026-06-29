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

const workspaceCommandFeedbackIntervalMs = 15_000
const workspaceCommandStartedMessage = "[vitehub] Workspace command started; first run may materialize sources.\n"
const workspaceCommandWaitingMessage = "[vitehub] Workspace command still running; sources may still be materializing.\n"

function startWorkspaceCommandFeedback(context: WorkspaceCliContext): () => void {
  context.stderr.write(workspaceCommandStartedMessage)
  const timer = setInterval(() => context.stderr.write(workspaceCommandWaitingMessage), workspaceCommandFeedbackIntervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

function writeWorkspaceDevUsage(context: WorkspaceCliContext): void {
  context.stdout.write([
    "Usage: vitehub workspace dev <workspace> [command...] [--url <url>] [--timeout <ms>]",
    "",
    "Run Workspace commands through a running Vite Development Server.",
    "",
    "Options:",
    "  --url <url>       Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --timeout <ms>    Workspace command timeout.",
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
    if (arg.startsWith("-") && !parsed.workspace) throw new Error(`Unknown option: ${arg}.`)
    if (!parsed.workspace) {
      parsed.workspace = arg
      continue
    }
    const [command, ...commandArgs] = args.slice(index)
    if (command?.trim()) {
      parsed.command = command
      if (commandArgs.length) parsed.args = commandArgs
    }
    break
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
  const stopFeedback = startWorkspaceCommandFeedback(context)
  try {
    const response = await fetchImpl(target.url, {
      body: JSON.stringify({
        workspaceCommand: {
          ...(parsed.args ? { args: parsed.args } : {}),
          command: parsed.command,
          ...(parsed.timeout ? { timeout: parsed.timeout } : {}),
          workspace: parsed.workspace,
        },
      }),
      headers: {
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
    const result = await response.json().catch(() => ({})) as { exitCode?: unknown, stderr?: unknown, stdout?: unknown }
    if (typeof result.stdout === "string") context.stdout.write(result.stdout)
    if (typeof result.stderr === "string" && result.stderr) context.stderr.write(result.stderr)
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
        usage: "vitehub workspace dev <workspace> [command...]",
      }],
      name: "workspace",
    }],
  }
}
