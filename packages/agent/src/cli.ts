import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { resolveAgentEvalOptions, writeAgentEvaliteConfig, type ResolvedAgentEvalOptions } from "./internal/evalite-config.ts"
import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute, readAgentInvocationStream } from "./invocation-stream.ts"

import type { AgentEvalOptions, AgentUsageRecord } from "./types.ts"
import type { UIMessageLike } from "./chat-message-input.ts"

interface AgentEvaliteRunnerOptions extends ResolvedAgentEvalOptions {
  cacheEnabled?: boolean
  cwd: string
  mode: "run-once-and-exit" | "watch-for-file-changes"
  outputPath?: string
  path?: string
  scoreThreshold?: number
}

type EvaliteRunner = (options: AgentEvaliteRunnerOptions) => Promise<{ exitCode?: number } | void>
type AgentEvaliteConfigWriter = (rootDir: string, options: ResolvedAgentEvalOptions) => Promise<string>

interface AgentCliContext {
  cwd: string
  env: NodeJS.ProcessEnv
  rootDir: string
  spawn?: unknown
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface AgentCliContributor {
  namespaces: Array<{
    description?: string
    features: Array<{
      description?: string
      name: string
      run: (args: string[], context: AgentCliContext) => Promise<number | void> | number | void
      usage?: string
    }>
    name: string
  }>
}

interface AgentCliContributorOptions {
  eval?: false | AgentEvalOptions
}

interface ParsedEvalArgs {
  help: boolean
  hideTable?: boolean
  noCache?: boolean
  outputPath?: string
  path?: string
  threshold?: number
  watch: boolean
}

interface ParsedDevArgs {
  agent?: string
  context?: Record<string, unknown>
  contextPath?: string
  help: boolean
  input?: unknown
  message?: string
  timeout?: number
  trigger?: string
  url: string
}

interface AgentDevCliOptions {
  fetch?: typeof fetch
}

interface AgentDevDiscovery {
  agents?: Array<{ name?: unknown, triggers?: unknown }>
  root?: unknown
}

const devPayloadMaxLength = 1200

function writeEvalUsage(context: AgentCliContext): void {
  context.stdout.write([
    "Usage: vitehub agent eval [path] [--watch] [--threshold <score>] [--output <path>] [--hide-table] [--no-cache]",
    "",
    "Runs discovered ViteHub Agent Evals with ViteHub defaults.",
    "",
    "Arguments:",
    "  path         Optional eval file path filter.",
    "",
    "Options:",
    "  --watch              Run Evalite in watch mode.",
    "  --threshold <score>  Fail when the score is below the threshold.",
    "  --output <path>      Write Evalite JSON results to a file.",
    "  --hide-table         Hide Evalite's detailed table output.",
    "  --no-cache           Disable Evalite model output caching.",
    "  -h, --help           Show this help.",
    "",
  ].join("\n"))
}

function writeDevUsage(context: AgentCliContext): void {
  context.stdout.write([
    "Usage: vitehub agent dev [message...] [--agent <name>] [--prompt <text>] [--trigger <id>] [--context <path>] [--input <json>] [--url <url>] [--timeout <ms>]",
    "",
    "Talk to a discovered Agent through a running Vite Development Server.",
    "",
    "Options:",
    "  --agent <name>    Agent Dev Loop Target. Required when multiple Agents are compatible.",
    "  -p, --prompt <text>  Prompt text for a one-shot invocation.",
    "  --trigger <id>    Agent Trigger to invoke. Defaults to chat.message when available.",
    "  --context <path>  Agent Invocation Context Values JSON file.",
    "  --input <json>    Raw Agent Trigger input JSON for one-shot invocations.",
    "  --url <url>       Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --timeout <ms>    Agent Invocation timeout. Defaults to 90000.",
    "  -h, --help        Show this help.",
    "",
  ].join("\n"))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function formatDevPayload(value: unknown): string | undefined {
  if (value === undefined) return
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (text === undefined) return
  return text.length > devPayloadMaxLength
    ? `${text.slice(0, devPayloadMaxLength)}... [truncated ${text.length - devPayloadMaxLength} chars]`
    : text
}

function writeDevPayload(context: AgentCliContext, label: string, value: unknown): void {
  const text = formatDevPayload(value)
  if (text === undefined) return
  context.stderr.write(`  ${label}: ${text}\n`)
}

function thinkingFallback(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return "Thinking..."
  const value = metadata?.thinkingFallback
  return typeof value === "string" && value.trim() ? value : undefined
}

function usageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined
}

function formatUsageNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value)
}

function readUsageDetail(...records: Array<Record<string, unknown> | undefined>): number | undefined {
  const keys = ["reasoningTokens", "reasoning_tokens", "thinkingTokens", "thinking_tokens", "reasoning", "thinking"]
  for (const record of records) {
    if (!record) continue
    for (const key of keys) {
      const value = usageNumber(record[key])
      if (value !== undefined) return value
    }
  }
}

function formatUsageRecord(record: AgentUsageRecord): string | undefined {
  const usage = record.usage
  const input = usageNumber(usage?.inputTokens)
  const output = usageNumber(usage?.outputTokens)
  const total = usageNumber(usage?.totalTokens) ?? (input !== undefined && output !== undefined ? input + output : undefined)
  const reasoning = readUsageDetail(usage?.outputTokenDetails, usage?.inputTokenDetails, usage?.details)
  const parts: string[] = []
  if (total !== undefined) {
    const tokens = `${formatUsageNumber(total)} tokens`
    parts.push(input !== undefined && output !== undefined ? `${tokens}: ${formatUsageNumber(input)} in / ${formatUsageNumber(output)} out` : tokens)
  }
  else if (input !== undefined || output !== undefined) {
    parts.push([input !== undefined ? `${formatUsageNumber(input)} in` : undefined, output !== undefined ? `${formatUsageNumber(output)} out` : undefined].filter(Boolean).join(" / "))
  }
  if (reasoning !== undefined) parts.push(`${formatUsageNumber(reasoning)} reasoning tokens`)
  if (!parts.length) return record.summary
  return parts.join("; ")
}

function readOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}.`)
  }
  return value
}

function parseEvalArgs(args: string[]): ParsedEvalArgs {
  const parsed: ParsedEvalArgs = {
    help: false,
    watch: false,
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") {
      parsed.help = true
      continue
    }
    if (arg === "--watch" || arg === "watch") {
      parsed.watch = true
      continue
    }
    if (arg === "--hide-table") {
      parsed.hideTable = true
      continue
    }
    if (arg === "--no-cache") {
      parsed.noCache = true
      continue
    }
    if (arg === "--threshold") {
      const value = readOptionValue(args, index, arg)
      const threshold = Number.parseFloat(value)
      if (!Number.isFinite(threshold)) {
        throw new Error("--threshold must be a number.")
      }
      parsed.threshold = threshold
      index++
      continue
    }
    if (arg.startsWith("--threshold=")) {
      const threshold = Number.parseFloat(arg.slice("--threshold=".length))
      if (!Number.isFinite(threshold)) {
        throw new Error("--threshold must be a number.")
      }
      parsed.threshold = threshold
      continue
    }
    if (arg === "--output" || arg === "--outputPath") {
      parsed.outputPath = readOptionValue(args, index, arg)
      index++
      continue
    }
    if (arg.startsWith("--output=")) {
      parsed.outputPath = arg.slice("--output=".length)
      continue
    }
    if (arg.startsWith("--outputPath=")) {
      parsed.outputPath = arg.slice("--outputPath=".length)
      continue
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}.`)
    }
    if (!parsed.path) {
      parsed.path = arg
      continue
    }
    throw new Error(`Unexpected argument: ${arg}.`)
  }

  return parsed
}

async function loadEvaliteRunner(): Promise<EvaliteRunner> {
  const { runAgentEvalite } = await import("./evalite-runner.js")
  return runAgentEvalite
}

export async function runAgentEvalCli(
  args: string[],
  context: AgentCliContext,
  options: false | AgentEvalOptions | undefined,
  runner?: EvaliteRunner,
  writeConfig: AgentEvaliteConfigWriter = writeAgentEvaliteConfig,
): Promise<number> {
  const resolvedOptions = resolveAgentEvalOptions(options)
  if (resolvedOptions === false) {
    context.stderr.write("Agent eval CLI is disabled by the Agent integration.\n")
    return 1
  }

  let parsed: ParsedEvalArgs
  try {
    parsed = parseEvalArgs(args)
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    writeEvalUsage(context)
    return 1
  }

  if (parsed.help) {
    writeEvalUsage(context)
    return 0
  }

  const run = runner || await loadEvaliteRunner()
  await writeConfig(context.rootDir, resolvedOptions)
  const result = await run({
    cache: resolvedOptions.cache,
    cacheEnabled: parsed.noCache ? false : undefined,
    cwd: context.rootDir,
    forceRerunTriggers: resolvedOptions.forceRerunTriggers,
    hideTable: parsed.hideTable ?? resolvedOptions.hideTable,
    maxConcurrency: resolvedOptions.maxConcurrency,
    mode: parsed.watch ? "watch-for-file-changes" : "run-once-and-exit",
    outputPath: parsed.outputPath,
    path: parsed.path,
    scoreThreshold: parsed.threshold ?? resolvedOptions.scoreThreshold,
    server: resolvedOptions.server,
    setupFiles: resolvedOptions.setupFiles,
    testTimeout: resolvedOptions.testTimeout,
    trialCount: resolvedOptions.trialCount,
  })

  return result?.exitCode ?? 0
}

function parseDevArgs(args: string[], env: NodeJS.ProcessEnv): ParsedDevArgs {
  const message: string[] = []
  const parsed: ParsedDevArgs = {
    help: false,
    url: env.VITEHUB_DEV_SERVER_URL || "http://localhost:5173",
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") {
      parsed.help = true
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
    if (arg === "-p" || arg === "--prompt") {
      parsed.message = readOptionValue(args, index, arg).trim()
      if (!parsed.message) throw new Error(`${arg} cannot be empty.`)
      index++
      continue
    }
    if (arg.startsWith("--prompt=")) {
      parsed.message = arg.slice("--prompt=".length).trim()
      if (!parsed.message) throw new Error("--prompt cannot be empty.")
      continue
    }
    if (arg === "--trigger") {
      parsed.trigger = readOptionValue(args, index, arg)
      index++
      continue
    }
    if (arg.startsWith("--trigger=")) {
      parsed.trigger = arg.slice("--trigger=".length)
      continue
    }
    if (arg === "--context") {
      parsed.contextPath = readOptionValue(args, index, arg)
      index++
      continue
    }
    if (arg.startsWith("--context=")) {
      parsed.contextPath = arg.slice("--context=".length)
      continue
    }
    if (arg === "--input") {
      parsed.input = JSON.parse(readOptionValue(args, index, arg))
      index++
      continue
    }
    if (arg.startsWith("--input=")) {
      parsed.input = JSON.parse(arg.slice("--input=".length))
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
    if (arg === "--timeout") {
      const timeout = Number.parseInt(readOptionValue(args, index, arg), 10)
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("--timeout must be a positive number.")
      parsed.timeout = timeout
      index++
      continue
    }
    if (arg.startsWith("--timeout=")) {
      const timeout = Number.parseInt(arg.slice("--timeout=".length), 10)
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("--timeout must be a positive number.")
      parsed.timeout = timeout
      continue
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}.`)
    }
    message.push(arg)
  }

  const text = message.join(" ").trim()
  if (text && parsed.message) throw new Error("Pass either --prompt or message text, not both.")
  if (text) parsed.message = text
  return parsed
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

async function readDevContextFile(path: string): Promise<{ path: string, value: Record<string, unknown> }> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown
  if (!isRecord(value)) {
    throw new Error("Agent Dev Loop context file must contain a JSON object.")
  }
  return { path, value }
}

async function loadDevContext(contextPath: string, rootDir: string, cwd: string): Promise<{ path: string, value: Record<string, unknown> }> {
  const rootPath = resolve(rootDir, contextPath)
  try {
    return await readDevContextFile(rootPath)
  }
  catch (error) {
    const cwdPath = resolve(cwd, contextPath)
    if (!isFileNotFound(error) || cwdPath === rootPath) throw error
    return await readDevContextFile(cwdPath)
  }
}

function endpointUrl(baseUrl: string): string {
  return new URL(agentInvocationStreamRoute, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href
}

async function readDiscovery(
  parsed: ParsedDevArgs,
  context: AgentCliContext,
  fetchImpl: typeof fetch,
): Promise<{ agent: string, url: string } | undefined> {
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
        [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
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

  const discovery = await response.json().catch(() => ({})) as AgentDevDiscovery
  if (typeof discovery.root === "string" && discovery.root !== context.rootDir) {
    context.stderr.write(`Compatible Vite Development Server root mismatch: ${discovery.root}\n`)
    return
  }
  const agents = (discovery.agents || []).flatMap(agent => typeof agent.name === "string" ? [agent.name] : [])
  if (parsed.agent) {
    if (!agents.includes(parsed.agent)) {
      context.stderr.write(`Unknown Agent Dev Loop Target: ${parsed.agent}\n`)
      return
    }
    return { agent: parsed.agent, url }
  }
  if (agents.length === 1) {
    return { agent: agents[0]!, url }
  }
  if (!agents.length) {
    context.stderr.write("No Agents discovered.\n")
    return
  }
  context.stderr.write(`Multiple Agents discovered. Pass --agent ${agents.join("|")}.\n`)
}

function userMessage(text: string, index: number): UIMessageLike {
  return {
    id: `dev-user-${index}`,
    parts: [{ text, type: "text" }],
    role: "user",
  }
}

function assistantMessage(text: string, index: number): UIMessageLike {
  return {
    id: `dev-assistant-${index}`,
    parts: [{ text, type: "text" }],
    role: "assistant",
  }
}

async function sendDevMessage(
  url: string,
  agent: string,
  text: string,
  history: UIMessageLike[],
  parsed: ParsedDevArgs,
  context: AgentCliContext,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<UIMessageLike[] | undefined> {
  const messages = text ? [...history, userMessage(text, history.length)] : history
  let response: Response
  try {
    response = await fetchImpl(url, {
      body: JSON.stringify({
        agent,
        ...(parsed.context ? { context: parsed.context } : {}),
        ...(messages.length ? { messages } : {}),
        ...("input" in parsed ? { input: parsed.input } : {}),
        ...(parsed.timeout ? { timeout: parsed.timeout } : {}),
        ...(parsed.trigger ? { trigger: parsed.trigger } : {}),
      }),
      headers: {
        "content-type": "application/json",
        [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
      },
      method: "POST",
      signal,
    })
  }
  catch (error) {
    if (signal?.aborted || error instanceof DOMException && error.name === "AbortError") {
      context.stderr.write("\n[aborted]\n")
      return history
    }
    throw error
  }
  if (!response.ok) {
    context.stderr.write(`${await response.text()}\n`)
    return
  }
  if (!response.body) {
    context.stderr.write("Agent Invocation Stream response had no body.\n")
    return
  }

  let output = ""
  let needsApproval = false
  let pendingFallback = false
  let wroteFallback = false
  const visibleTools = new Set<string>()
  const clearPendingFallback = () => {
    if (!pendingFallback) return
    context.stderr.write("\r\u001b[K")
    pendingFallback = false
  }
  try {
    for await (const event of readAgentInvocationStream(response.body)) {
      if (event.type === "start") {
        if (wroteFallback) continue
        const fallback = thinkingFallback(event.metadata)
        if (fallback) {
          context.stderr.write(fallback)
          pendingFallback = true
        }
        wroteFallback = true
        continue
      }
      if (event.type === "text-delta") {
        clearPendingFallback()
        context.stdout.write(event.text)
        output += event.text
        continue
      }
      if (event.type === "tool-call" || event.type === "tool-input-start") {
        clearPendingFallback()
        visibleTools.add(event.id)
        context.stderr.write(`\n[tool] ${event.name}\n`)
        writeDevPayload(context, "input", event.input)
        continue
      }
      if (event.type === "tool-result") {
        clearPendingFallback()
        if (!visibleTools.has(event.id)) {
          visibleTools.add(event.id)
          context.stderr.write(`\n[tool] ${event.name}\n`)
        }
        writeDevPayload(context, "output", event.output)
        writeDevPayload(context, "error", event.error)
        continue
      }
      if (event.type === "usage") {
        clearPendingFallback()
        const usage = formatUsageRecord(event.usageRecord)
        if (usage) context.stderr.write(`\n[usage] ${usage}\n`)
        continue
      }
      if (event.type === "delivery-preview") {
        clearPendingFallback()
        context.stderr.write(`\n[delivery preview] would ${event.effect.kind}${event.channelId ? ` on ${event.channelId}` : ""}\n`)
        writeDevPayload(context, "intent", event.effect.intent)
        writeDevPayload(context, "payload", event.effect.payload)
        writeDevPayload(context, "metadata", event.effect.metadata)
        continue
      }
      if (event.type === "approval-request") {
        clearPendingFallback()
        context.stderr.write(`\n[approval required] ${event.name}${event.reason ? `: ${event.reason}` : ""}\n`)
        needsApproval = true
        continue
      }
      if (event.type === "approval-decision") {
        clearPendingFallback()
        context.stderr.write(`\n[approval ${event.approved ? "approved" : "rejected"}]${event.reason ? ` ${event.reason}` : ""}\n`)
        continue
      }
      if (event.type === "error") {
        clearPendingFallback()
        context.stderr.write(`\n${event.error}\n`)
        return
      }
    }
  }
  catch (error) {
    if (signal?.aborted || error instanceof DOMException && error.name === "AbortError") {
      context.stderr.write("\n[aborted]\n")
      return history
    }
    throw error
  }
  clearPendingFallback()
  context.stdout.write("\n")
  if (!output && needsApproval) return
  return messages.length || output ? [...messages, assistantMessage(output, messages.length)] : []
}

async function runInteractiveDevLoop(
  parsed: ParsedDevArgs,
  context: AgentCliContext,
  fetchImpl: typeof fetch,
  target: { agent: string, url: string },
): Promise<number> {
  const { createInterface } = await import("node:readline/promises")
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  let history: UIMessageLike[] = []
  let activeRequest: AbortController | undefined
  let exit = false
  const onSigint = () => {
    if (activeRequest) {
      activeRequest.abort()
      return
    }
    exit = true
    readline.close()
  }
  readline.on("SIGINT", onSigint)
  context.stdout.write(`Connected to ${target.agent} at ${parsed.url}\n`)
  try {
    for (;;) {
      let text: string
      try {
        text = (await readline.question("> ")).trim()
      }
      catch (error) {
        if (exit) return 0
        throw error
      }
      if (!text) continue
      if (text === ".exit" || text === "exit") return 0
      activeRequest = new AbortController()
      try {
        const nextHistory = await sendDevMessage(target.url, target.agent, text, history, parsed, context, fetchImpl, activeRequest.signal)
        if (!nextHistory) return 1
        history = nextHistory
      }
      finally {
        activeRequest = undefined
      }
    }
  }
  finally {
    readline.off("SIGINT", onSigint)
    readline.close()
  }
}

export async function runAgentDevCli(
  args: string[],
  context: AgentCliContext,
  options: AgentDevCliOptions = {},
): Promise<number> {
  let parsed: ParsedDevArgs
  try {
    parsed = parseDevArgs(args, context.env)
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    writeDevUsage(context)
    return 1
  }
  if (parsed.help) {
    writeDevUsage(context)
    return 0
  }
  if (parsed.contextPath) {
    try {
      const loaded = await loadDevContext(parsed.contextPath, context.rootDir, context.cwd)
      parsed.context = loaded.value
      context.stdout.write(`Loaded context: ${loaded.path}\n`)
    }
    catch (error) {
      context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  const fetchImpl = options.fetch || globalThis.fetch
  const target = await readDiscovery(parsed, context, fetchImpl)
  if (!target) return 1

  if (parsed.message || "input" in parsed) {
    return await sendDevMessage(target.url, target.agent, parsed.message || "", [], parsed, context, fetchImpl, new AbortController().signal) ? 0 : 1
  }
  if (!process.stdin.isTTY) {
    context.stderr.write("Pass a message or run in an interactive terminal.\n")
    return 1
  }
  return await runInteractiveDevLoop(parsed, context, fetchImpl, target)
}

export function createAgentCliContributor(options?: false | AgentCliContributorOptions): AgentCliContributor | undefined {
  if (options === false) return
  const evalOptions = resolveAgentEvalOptions(options?.eval)
  const features: AgentCliContributor["namespaces"][number]["features"] = [
    {
      description: "Talk to a discovered Agent through a running Vite Development Server.",
      name: "dev",
      run: async (args, context) => await runAgentDevCli(args, context),
      usage: "vitehub agent dev [message...] [--agent <name>]",
    },
  ]
  if (evalOptions !== false) {
    features.unshift({
      description: "Run ViteHub Agent Evals.",
      name: "eval",
      run: async (args, context) => await runAgentEvalCli(args, context, evalOptions),
      usage: "vitehub agent eval [path] [--watch]",
    })
  }
  return {
    namespaces: [{
      description: "Agent development workflows.",
      features,
      name: "agent",
    }],
  }
}
