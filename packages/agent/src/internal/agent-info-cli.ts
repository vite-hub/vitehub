import { chatDevtoolsBridgeRoute, type ChatDevtoolsMetadata, type ChatDevtoolsStateResult } from "../chat/devtools-shared.ts"

interface AgentInfoCliContext {
  env: NodeJS.ProcessEnv
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface AgentInfoCliOptions {
  fetch?: typeof fetch
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

function countAgentInfoFiles(files: NonNullable<ChatDevtoolsStateResult["files"]>): { directories: number, files: number, sources: number } {
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

function agentInfoDriver(config: ChatDevtoolsStateResult["config"]): string {
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

function writeAgentInfo(context: AgentInfoCliContext, state: ChatDevtoolsStateResult): void {
  const files = countAgentInfoFiles(state.files || [])
  const metadata = state.metadataError
    ? `${state.metadataStatus || "error"} (${state.metadataError})`
    : state.metadataStatus || "ready"
  context.stdout.write([
    `Agent: ${state.selected || "unknown"}`,
    `Metadata: ${metadata}`,
    `Driver: ${agentInfoDriver(state.config)}`,
    `Tools: ${plural(state.tools?.length || 0, "tool")} (${agentInfoNames(state.tools || [], "none")})`,
    `Workspace files: ${plural(files.files, "file")}, ${plural(files.directories, "directory", "directories")}, ${plural(files.sources, "source")}`,
    `Instructions: ${plural(state.instructions?.length || 0, "document")}`,
    `Invoker profiles: ${plural(state.invokerProfiles?.length || 0, "profile")}`,
    `Warnings: ${plural(state.warnings?.length || 0, "warning")}`,
    "",
  ].join("\n"))
}

function agentInfoMetadata(state: ChatDevtoolsStateResult): ChatDevtoolsMetadata {
  return {
    ...(state.config ? { config: state.config } : {}),
    files: state.files || [],
    instructions: state.instructions || [],
    invokerProfiles: state.invokerProfiles || [],
    name: state.selected,
    tools: state.tools || [],
    ...(state.version ? { version: state.version } : {}),
    warnings: state.warnings || [],
  }
}

async function fetchAgentInfoState(url: string, agent: string | undefined, fetchImpl: typeof fetch): Promise<Response> {
  return await fetchImpl(url, {
    body: JSON.stringify({ action: "get-state", ...(agent ? { chat: agent } : {}) }),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
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
    url = new URL(chatDevtoolsBridgeRoute, parsed.url.endsWith("/") ? parsed.url : `${parsed.url}/`).href
  }
  catch {
    context.stderr.write(`Invalid Vite Development Server URL: ${parsed.url}\n`)
    return 1
  }

  const fetchImpl = options.fetch || globalThis.fetch
  let state: ChatDevtoolsStateResult
  const startedAt = Date.now()
  for (;;) {
    let response: Response
    try {
      response = await fetchAgentInfoState(url, parsed.agent, fetchImpl)
    }
    catch {
      context.stderr.write(`No Compatible Vite Development Server found at ${parsed.url}.\n`)
      return 1
    }
    if (!response.ok) {
      context.stderr.write(`Agent inspection is unavailable at ${parsed.url}. Start the Vite Development Server with Agent DevTools enabled.\n`)
      return 1
    }
    try {
      state = await response.json() as ChatDevtoolsStateResult
    }
    catch {
      context.stderr.write(`Agent inspection returned an invalid response from ${parsed.url}.\n`)
      return 1
    }

    const agents = state.chats?.map(chat => chat.name) || []
    if (!agents.length) {
      context.stderr.write("No chat-capable Agents discovered.\n")
      return 1
    }
    if (parsed.agent && !agents.includes(parsed.agent)) {
      context.stderr.write(`Unknown Agent inspection target: ${parsed.agent}\n`)
      return 1
    }
    if (!parsed.agent && agents.length > 1) {
      context.stderr.write(`Multiple Agents discovered. Pass --agent ${agents.join("|")}.\n`)
      return 1
    }
    if (state.metadataStatus !== "loading") break
    if (Date.now() - startedAt >= 30_000) {
      context.stderr.write(`Agent metadata is still loading for ${state.selected}.\n`)
      return 1
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  if (parsed.json) context.stdout.write(`${JSON.stringify(agentInfoMetadata(state), null, 2)}\n`)
  else writeAgentInfo(context, state)
  return state.metadataError ? 1 : 0
}
