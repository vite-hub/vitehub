import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } from "../invocation-stream.ts"

import type { AgentInspectionMetadata } from "../types.ts"
import type { AgentDevLoopDiscoveryResponse } from "../invocation-stream.ts"

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
  help: boolean
  json: boolean
  url: string
}

function writeInfoUsage(context: AgentInfoCliContext): void {
  context.stdout.write([
    "Usage: vitehub agent info [--agent <name>] [--url <url>] [--json]",
    "",
    "Inspect a discovered Agent through a running Vite Development Server.",
    "",
    "Options:",
    "  --agent <name>  Agent to inspect. Required when multiple Agents are available.",
    "  --url <url>     Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --json          Print structured Agent metadata.",
    "  -h, --help      Show this help.",
    "",
  ].join("\n"))
}

function readOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("-")) throw new Error(`Missing value for ${flag}.`)
  return value
}

function parseInfoArgs(args: string[], env: NodeJS.ProcessEnv): ParsedInfoArgs {
  const parsed: ParsedInfoArgs = {
    help: false,
    json: false,
    url: env.VITEHUB_DEV_SERVER_URL || "http://localhost:5173",
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
    if (arg === "--agent") {
      parsed.agent = readOptionValue(args, index, arg)
      index++
      continue
    }
    if (arg.startsWith("--agent=")) {
      parsed.agent = arg.slice("--agent=".length)
      continue
    }
    if (arg === "--url" || arg === "--server") {
      parsed.url = readOptionValue(args, index, arg)
      index++
      continue
    }
    if (arg.startsWith("--url=")) {
      parsed.url = arg.slice("--url=".length)
      continue
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}.`)
    throw new Error(`Unexpected argument: ${arg}.`)
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
  if (driver.kind === "harness") return driver.harness?.provider ? `Harness-backed Agent Driver (${driver.harness.provider})` : "Harness-backed Agent Driver"
  return "Custom-run Agent Driver"
}

function agentInfoNames(values: Array<{ name: string }>, fallback: string): string {
  if (!values.length) return fallback
  const names = values.slice(0, 5).map(value => value.name)
  return values.length > names.length ? `${names.join(", ")}, +${values.length - names.length} more` : names.join(", ")
}

function writeAgentInfo(context: AgentInfoCliContext, metadata: AgentInspectionMetadata): void {
  const files = countAgentInfoFiles(metadata.files || [])
  context.stdout.write([
    `Agent: ${metadata.name || "unknown"}`,
    "Metadata: ready",
    `Driver: ${agentInfoDriver(metadata.config)}`,
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

async function fetchAgentInfo(url: string, fetchImpl: typeof fetch, timeout: number): Promise<Response> {
  return await fetchImpl(url, {
    headers: {
      accept: "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    },
    signal: AbortSignal.timeout(timeout),
  })
}

export async function runAgentInfoCli<TContext extends AgentInfoCliContext>(
  args: string[],
  context: TContext,
  options: AgentInfoCliOptions = {},
): Promise<number> {
  let parsed: ParsedInfoArgs
  try {
    parsed = parseInfoArgs(args, context.env)
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    writeInfoUsage(context)
    return 1
  }
  if (parsed.help) {
    writeInfoUsage(context)
    return 0
  }

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
    response = await fetchAgentInfo(url, fetchImpl, timeout)
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

  let result: AgentDevLoopDiscoveryResponse
  try {
    result = await response.json() as AgentDevLoopDiscoveryResponse
  }
  catch {
    context.stderr.write(`Agent inspection returned an invalid response from ${parsed.url}.\n`)
    return 1
  }
  if (typeof result.root === "string" && result.root !== context.rootDir) {
    context.stderr.write(`Compatible Vite Development Server root mismatch: ${result.root}\n`)
    return 1
  }
  if (!result.inspection) {
    context.stderr.write(`Agent inspection returned an invalid response from ${parsed.url}.\n`)
    return 1
  }

  if (parsed.json) context.stdout.write(`${JSON.stringify(agentInfoMetadata(result.inspection), null, 2)}\n`)
  else writeAgentInfo(context, result.inspection)
  return 0
}
