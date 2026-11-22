import { asUnknownBoundary, isRuntimeRecord } from "./runtime-type.ts"

import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { requireViteHubDevServerUrl } from "@vite-hub/internal/cli"
import { callOperationFromCli } from "@vite-hub/internal/operations"
import { formatRuntimeDiagnosticError, isExecutionAuthority, isRuntimeDiagnostic, type ExecutionAuthority } from "@vite-hub/runtime"

import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } from "../invocation-stream.ts"
import { isCompatibleAgentDevServerRoot, readAgentDevLoopTokenHeaders } from "./agent-dev-loop-cli.ts"

import type { AgentInspectionMetadata } from "../types.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"

interface AgentInfoCliContext {
  env: NodeJS.ProcessEnv
  rootDir: string
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface AgentInfoCliOptions {
  fetch?: typeof fetch
  timeout?: number
}

interface ParsedInfoArgs {
  agent?: string
  console: boolean
  help: boolean
  json: boolean
  url: string
}

function writeInfoUsage(context: AgentInfoCliContext): void {
  context.stdout.write([
    "Usage: vitehub agent get [name] [--url <app>] [--dev] [--json]",
    "",
    "Inspect one Agent through the running dev server, or through an app's Console.",
    "The name is required when the app has several Agents.",
    "",
    "Options:",
    "  --url <url>     App URL, such as http://localhost:3000. Defaults to the dev server running in this project,",
    "                  then VITEHUB_DEV_SERVER_URL.",
    "  --dev           Inspect the guarded Dev Loop instead of the Console at the explicit URL.",
    "  --json          Print structured Agent metadata.",
    "  -h, --help      Show this help.",
    "",
  ].join("\n"))
}

function readOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("-")) throw agentDiagnostics.AGENT_R0498({ message: `Missing value for ${flag}.` })
  return value
}

function parseInfoArgs(args: string[], context: Pick<AgentInfoCliContext, "env" | "rootDir">): ParsedInfoArgs {
  const parsed: Omit<ParsedInfoArgs, "url" | "console"> & { url?: string } = { help: false, json: false }
  let dev = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") {
      parsed.help = true
      continue
    }
    if (arg === "--json") {
      parsed.json = true
      continue
    }
    if (arg === "--agent" || arg.startsWith("--agent=")) {
      const name = arg === "--agent" ? args[index + 1] : arg.slice("--agent=".length)
      throw agentDiagnostics.AGENT_R0499({ message: `--agent is now the name argument. Run vitehub agent get ${name && !name.startsWith("-") ? name : "<name>"}.` })
    }
    if (arg === "--dev") {
      dev = true
      continue
    }
    if (arg === "--server" || arg.startsWith("--server=")) throw agentDiagnostics.AGENT_R0499({ message: "--server is now --dev --url. Pass --dev --url with the Dev Loop URL, such as --dev --url http://localhost:3000." })
    if (arg === "--url") {
      parsed.url = readOptionValue(args, index, arg)
      index++
      continue
    }
    if (arg.startsWith("--url=")) {
      const value = arg.slice("--url=".length)
      if (!value) throw agentDiagnostics.AGENT_R0498({ message: `Missing value for ${arg}.` })
      parsed.url = value
      continue
    }
    if (arg.startsWith("-")) throw agentDiagnostics.AGENT_R0499({ message: `Unknown option: ${arg}.` })
    if (parsed.agent === undefined) {
      parsed.agent = arg
      continue
    }
    throw agentDiagnostics.AGENT_R0500({ message: `Unexpected argument: ${arg}.` })
  }

  // A Nuxt or Vite dev server records its URL in the project root, and Nuxt's Vite root is the `app/` folder below it.
  // Help needs no server, and the command never guesses a port.
  return { ...parsed, console: parsed.url !== undefined && !dev, url: parsed.url ?? (parsed.help ? "" : requireViteHubDevServerUrl([...new Set([context.rootDir, resolveViteHubProjectRoot(context.rootDir)])], context.env, "agent get")) }
}

function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`
}

function countAgentInfoFiles(files: NonNullable<AgentInspectionMetadata["files"]>): { directories: number, files: number, sources: number } {
  const sources = new Set<string>()
  let fileCount = 0
  let directoryCount = 0
  const pending = [...files]
  while (pending.length) {
    const file = pending.shift()!
    if (file.kind === "directory") directoryCount += 1
    else fileCount += 1
    if (file.source) sources.add(file.source)
    pending.push(...(file.children || []))
  }
  return { directories: directoryCount, files: fileCount, sources: sources.size }
}

function agentInfoDriver(config: AgentInspectionMetadata["config"]): string {
  const driver = config?.driver
  if (!driver) return "unavailable"
  if (driver.kind === "model") return driver.model?.id ? `Model-backed Agent Driver (${driver.model.id})` : "Model-backed Agent Driver"
  if (driver.kind === "provider") return driver.provider?.provider ? `Provider Agent Driver (${driver.provider.provider})` : "Provider Agent Driver"
  if (driver.kind === "run") return "Custom-run Agent Driver"
  if (driver.kind === "ask") return "Ask Agent Driver"
  if (driver.kind === "external") return "External Agent Driver (runs outside the app)"
  return "Unknown Agent Driver"
}

function agentInfoCapacity(config: AgentInspectionMetadata["config"]): string {
  const capacity = config?.driver?.capacity
  if (!capacity) return "unlimited"
  const queue = capacity.queue
    ? `${capacity.pending}/${capacity.queue.maxPending} pending${capacity.queue.timeout ? `, ${capacity.queue.timeout}ms timeout` : ""}`
    : "queue disabled"
  if (capacity.effectiveConcurrency !== undefined) {
    const reason = capacity.reason ? `, ${capacity.reason}` : ""
    return `${capacity.active} active, ${capacity.effectiveConcurrency} admitted, ${capacity.concurrency} hard max, ${queue}${reason}`
  }
  return `${capacity.active}/${capacity.concurrency} active, ${queue}`
}

function agentInfoExecutionAuthority(authority: ExecutionAuthority): string[] {
  const filesystem = authority.filesystem.scope === authority.filesystem.access
    ? authority.filesystem.scope
    : `${authority.filesystem.scope}, ${authority.filesystem.access}`
  return [
    "Execution authority:",
    `  Filesystem: ${filesystem}`,
    `  Network: ${authority.network}`,
    `  Environment: ${authority.environment}`,
    `  Credentials: ${authority.credentials}`,
    `  Process execution: ${authority.processes}`,
    `  Isolation: ${authority.isolation}`,
  ]
}

function agentInfoNames(values: Array<{ id?: string, name?: string }>, fallback: string): string {
  if (!values.length) return fallback
  const names = values.slice(0, 5).map(value => value.name || value.id).filter(value => value !== undefined)
  if (!names.length) return fallback
  return values.length > names.length ? `${names.join(", ")}, +${values.length - names.length} more` : names.join(", ")
}

function writeAgentInfo(context: AgentInfoCliContext, metadata: AgentInspectionMetadata, emulator: AgentEmulatorInfo | undefined): void {
  const files = countAgentInfoFiles(metadata.files || [])
  const authority = metadata.config?.driver?.executionAuthority
  context.stdout.write([
    `Agent: ${metadata.name || "unknown"}`,
    "Metadata: ready",
    `Driver: ${agentInfoDriver(metadata.config)}`,
    // The dev server reports the emulator for the whole project. Provider status tells if this Driver runs on it.
    ...(emulator ? [`AI emulator: ${emulator.url} (the dev server sets VITEHUB_MODELS=emulate)`] : []),
    `Capacity: ${agentInfoCapacity(metadata.config)}`,
    ...(isExecutionAuthority(authority) ? agentInfoExecutionAuthority(authority) : ["Execution authority: unavailable"]),
    `Capabilities: ${plural(metadata.capabilities?.length || 0, "Capability", "Capabilities")} (${agentInfoNames(metadata.capabilities || [], "none")})`,
    `Tools: ${plural(metadata.tools?.length || 0, "tool")} (${agentInfoNames(metadata.tools || [], "none")})`,
    `Workspace files: ${plural(files.files, "file")}, ${plural(files.directories, "directory", "directories")}, ${plural(files.sources, "source")}`,
    `Instructions: ${plural(metadata.instructions?.length || 0, "document")}`,
    `Invoker profiles: ${plural(metadata.invokerProfiles?.length || 0, "profile")}`,
    `Warnings: ${plural(metadata.warnings?.length || 0, "warning")}`,
    "",
  ].join("\n"))
}

/** The AI emulator that the dev server reports when `VITEHUB_MODELS=emulate` is set. */
interface AgentEmulatorInfo {
  url: string
}

function agentEmulatorInfo(discovery: Record<PropertyKey, unknown>): AgentEmulatorInfo | undefined {
  const emulator = discovery.emulator
  return isRuntimeRecord(emulator) && typeof emulator.url === "string" && emulator.url ? { url: emulator.url } : undefined
}

function agentInfoMetadata(metadata: AgentInspectionMetadata, emulator: AgentEmulatorInfo | undefined): AgentInspectionMetadata & { emulator?: AgentEmulatorInfo } {
  return {
    ...(metadata.capabilities ? { capabilities: metadata.capabilities } : {}),
    ...(metadata.config ? { config: metadata.config } : {}),
    ...(emulator ? { emulator } : {}),
    files: metadata.files || [],
    instructions: metadata.instructions || [],
    invokerProfiles: metadata.invokerProfiles || [],
    name: metadata.name,
    tools: metadata.tools || [],
    ...(metadata.version ? { version: metadata.version } : {}),
    warnings: metadata.warnings || [],
  }
}

async function fetchAgentInfo(url: string, rootDir: string, fetchImpl: typeof fetch, timeout: number): Promise<Response> {
  const signal = AbortSignal.timeout(timeout)
  const discovery = new URL(url)
  discovery.search = ""
  return await fetchImpl(url, {
    redirect: "manual",
    headers: {
      accept: "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
      ...await readAgentDevLoopTokenHeaders(discovery.href, rootDir, fetchImpl, signal),
    },
    signal,
  })
}

async function readDeployedAgent(parsed: ParsedInfoArgs, context: AgentInfoCliContext, options: AgentInfoCliOptions): Promise<number> {
  const result = await callOperationFromCli({
    env: context.env,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    rootDir: context.rootDir,
    ...(options.timeout ? { timeout: options.timeout } : {}),
    url: parsed.url,
  }, "status.get", parsed.agent === undefined ? {} : { agent: parsed.agent })
  if (!result.ok) {
    context.stderr.write(`${result.code}: ${result.message}${result.fix ? `\n${result.fix}` : ""}\n`)
    return 1
  }
  context.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`)
  return 0
}

export async function runAgentInfoCli<TContext extends AgentInfoCliContext>(
  args: string[],
  context: TContext,
  options: AgentInfoCliOptions = {},
): Promise<number> {
  let parsed: ParsedInfoArgs
  try {
    parsed = parseInfoArgs(args, context)
  }
  catch (error) {
    context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
    writeInfoUsage(context)
    return 1
  }
  if (parsed.help) {
    writeInfoUsage(context)
    return 0
  }
  if (parsed.console) return await readDeployedAgent(parsed, context, options)

  let url: string
  try {
    const endpoint = new URL(agentInvocationStreamRoute, parsed.url.endsWith("/") ? parsed.url : `${parsed.url}/`)
    endpoint.searchParams.set("inspect", "1")
    if (parsed.agent) endpoint.searchParams.set("agent", parsed.agent)
    url = endpoint.href
  }
  catch {
    context.stderr.write(`Invalid Vite Development Server URL: ${parsed.url}\n`)
    return 1
  }

  const fetchImpl = options.fetch || globalThis.fetch
  const timeout = options.timeout ?? 30_000
  let response: Response
  try {
    response = await fetchAgentInfo(url, context.rootDir, fetchImpl, timeout)
  }
  catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      context.stderr.write(`Agent inspection request timed out after ${timeout}ms.\n`)
      return 1
    }
    if (isRuntimeDiagnostic(error) && error.code === "AGENT_DEV_LOOP_FAILED") {
      context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
      return 1
    }
    context.stderr.write(`No Compatible Vite Development Server found at ${parsed.url}.\n`)
    return 1
  }
  if (!response.ok) {
    const message = (await response.text()).trim()
    context.stderr.write(`${message || `Agent inspection is unavailable at ${parsed.url}.`}\n`)
    return 1
  }

  let result: Record<PropertyKey, unknown>
  try {
    const value: unknown = await response.json()
    if (!isRuntimeRecord(value)) throw agentDiagnostics.AGENT_R0501({ message: "Invalid Agent discovery response" })
    result = value
  }
  catch {
    context.stderr.write(`Agent inspection returned an invalid response from ${parsed.url}.\n`)
    return 1
  }
  if (typeof result.root === "string" && !isCompatibleAgentDevServerRoot(context.rootDir, result.root)) {
    context.stderr.write(`Compatible Vite Development Server root mismatch: ${result.root}\n`)
    return 1
  }
  if (!isRuntimeRecord(result.inspection)) {
    context.stderr.write(`Agent inspection returned an invalid response from ${parsed.url}.\n`)
    return 1
  }
  // SAFETY: The discovery response parser verifies that inspection metadata is a record before its owned fields are rendered.
  const inspection = asUnknownBoundary(result.inspection) as AgentInspectionMetadata

  const emulator = agentEmulatorInfo(result)
  if (parsed.json) context.stdout.write(`${JSON.stringify(agentInfoMetadata(inspection, emulator), null, 2)}\n`)
  else writeAgentInfo(context, inspection, emulator)
  return 0
}
