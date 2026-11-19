import { asUnknownBoundary, isRuntimeRecord } from "./runtime-type.ts"
import { isAbsolute, relative, resolve, sep } from "node:path"

import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { defaultViteHubDevServerUrl, findViteHubDevServerUrl } from "@vite-hub/internal/cli"
import { callOperationFromCli } from "@vite-hub/internal/operations"
import { formatRuntimeDiagnosticError, isExecutionAuthority, type ExecutionAuthority } from "@vite-hub/runtime"

import { readWorkspaceDevToken, workspaceDevTokenHeader } from "@vite-hub/workspace/server"

import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } from "../invocation-stream.ts"

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
  target?: "console" | "dev"
  help: boolean
  json: boolean
  url: string
}

export function isCompatibleAgentDevServerRoot(rootDir: string, serverRoot: string): boolean {
  const nestedPath = relative(resolve(rootDir), resolve(serverRoot))
  return nestedPath === "" || (nestedPath !== ".." && !nestedPath.startsWith(`..${sep}`) && !isAbsolute(nestedPath))
}

/**
 * Reads the private Agent Dev Loop token for the server at `endpoint`. The discovery `GET` returns the server root and
 * the token server ID, and the CLI reads the token file locally. Returns no header when the server publishes no token
 * scope or its root is outside `rootDir`. The endpoint then rejects the request.
 */
export async function readAgentDevLoopTokenHeaders(endpoint: string, rootDir: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Record<string, string>> {
  const response = await fetchImpl(endpoint, {
    headers: { accept: "application/json", [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    await response.body?.cancel()
    return {}
  }
  const discovery: unknown = await response.json().catch(() => undefined)
  if (!isRuntimeRecord(discovery) || typeof discovery.root !== "string" || typeof discovery.workspaceDevTokenServerId !== "string") return {}
  if (!isCompatibleAgentDevServerRoot(rootDir, discovery.root)) return {}
  const token = await readWorkspaceDevToken(discovery.root, { serverId: discovery.workspaceDevTokenServerId })
  return token ? { [workspaceDevTokenHeader]: token } : {}
}

function writeInfoUsage(context: AgentInfoCliContext): void {
  context.stdout.write([
    "Usage: vitehub agent get [name] [--url <app> | --server <dev-url>] [--json]",
    "",
    "Inspect one Agent through the running dev server, or through an app's Console.",
    "The name is required when the app has several Agents.",
    "",
    "Options:",
    "  --url <app>     App URL for Console inspection, including locally served production builds.",
    "  --server <url>  Agent Dev Loop URL. Defaults to the dev server running in this project,",
    "                  then VITEHUB_DEV_SERVER_URL, then http://localhost:5173.",
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
  const parsed: ParsedInfoArgs = {
    help: false,
    json: false,
    // A Nuxt or Vite dev server records its URL in the project root, so a port other than 5173 needs no --url.
    // Nuxt's Vite root is the `app/` folder below it.
    url: findViteHubDevServerUrl([...new Set([context.rootDir, resolveViteHubProjectRoot(context.rootDir)])], context.env) ?? defaultViteHubDevServerUrl,
  }

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
    const targetFlag = /^--(url|server)(?:=|$)/.exec(arg)
    if (targetFlag) {
      const flag = `--${targetFlag[1]}`
      const target = flag === "--url" ? "console" : "dev"
      if (parsed.target && parsed.target !== target) throw agentDiagnostics.AGENT_R0499({ message: "Pass --url or --server, not both." })
      const value = arg === flag ? readOptionValue(args, index++, flag) : arg.slice(flag.length + 1)
      if (!value) throw agentDiagnostics.AGENT_R0498({ message: `Missing value for ${arg}.` })
      parsed.url = value
      parsed.target = target
      continue
    }
    if (arg.startsWith("-")) throw agentDiagnostics.AGENT_R0499({ message: `Unknown option: ${arg}.` })
    if (parsed.agent === undefined) {
      parsed.agent = arg
      continue
    }
    throw agentDiagnostics.AGENT_R0500({ message: `Unexpected argument: ${arg}.` })
  }

  return parsed
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

function writeAgentInfo(context: AgentInfoCliContext, metadata: AgentInspectionMetadata): void {
  const files = countAgentInfoFiles(metadata.files || [])
  const authority = metadata.config?.driver?.executionAuthority
  context.stdout.write([
    `Agent: ${metadata.name || "unknown"}`,
    "Metadata: ready",
    `Driver: ${agentInfoDriver(metadata.config)}`,
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

function agentInfoMetadata(metadata: AgentInspectionMetadata): AgentInspectionMetadata {
  return {
    ...(metadata.capabilities ? { capabilities: metadata.capabilities } : {}),
    ...(metadata.config ? { config: metadata.config } : {}),
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

/** `vitehub agent get --url <deployed app>`: the `status.get` operation of the app's Console RPC. */
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
  if (parsed.target === "console") return await readDeployedAgent(parsed, context, options)

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

  if (parsed.json) context.stdout.write(`${JSON.stringify(agentInfoMetadata(inspection), null, 2)}\n`)
  else writeAgentInfo(context, inspection)
  return 0
}
