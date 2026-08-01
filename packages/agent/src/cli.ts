import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { readWorkspaceDevToken, workspaceDevTokenHeader } from "@vite-hub/workspace/server"

import { formatAgentError } from "./agent-error.ts"
import { createAgentEvalInclude, discoverAgentEvalFiles } from "./discovery.ts"
import { runAgentInfoCli } from "./internal/agent-info-cli.ts"
import { runAgentChannelSyncCli } from "./internal/channel-sync-cli.ts"
import { vercelAiGatewayPricing, type AgentUsagePricing } from "./internal/usage-pricing.ts"
import { resolveAgentEvalOptions, writeAgentEvaliteConfig, type ResolvedAgentEvalOptions } from "./internal/evalite-config.ts"
import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute, readAgentInvocationStream } from "./invocation-stream.ts"

import type { AgentDevLoopDiscoveryResponse } from "./invocation-stream.ts"
import type { AgentEvalOptions, AgentUsageRecord } from "./types.ts"
import type { UIMessageLike } from "./chat-message-input.ts"
import type { WorkspaceDevTokenOptions } from "@vite-hub/workspace/server"

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
  eval?: AgentEvalOptions
  rootDir?: string
  serverDirs?: string[]
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
  cli?: string
  cliArgv?: string[]
  help: boolean
  message?: string
  payload?: Record<string, unknown>
  payloadPath?: string
  timeout?: number
  trigger?: string
  url: string
  workspaceCommand?: WorkspaceCommandInput
}

interface WorkspaceCommandInput {
  args?: string[]
  command: string
}

const workspaceCommandFeedbackIntervalMs = 15_000
const workspaceCommandStartedMessage = "[workspace] command started; first run may materialize sources.\n"
const workspaceCommandWaitingMessage = "[workspace] command still running; sources may still be materializing.\n"

function startWorkspaceCommandFeedback(context: AgentCliContext): () => void {
  context.stderr.write(workspaceCommandStartedMessage)
  const timer = setInterval(() => context.stderr.write(workspaceCommandWaitingMessage), workspaceCommandFeedbackIntervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

interface AgentDevCliOptions {
  fetch?: typeof fetch
}

interface AgentDevTarget {
  agent: string
  tokenOptions: WorkspaceDevTokenOptions
  url: string
}

const devPayloadMaxLength = 1200

let devUsagePricing: AgentUsagePricing | undefined

function defaultDevUsagePricing() {
  return devUsagePricing ??= vercelAiGatewayPricing()
}

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
    "Usage: vitehub agent dev [message...] [--agent <name>] [--prompt <text>] [--trigger <id>] [--payload <path>] [--url <url>] [--timeout <ms>]",
    "       vitehub agent dev --agent <name> --cli <name> -- <command...>",
    "",
    "Talk to a discovered Agent through a running Vite Development Server.",
    "",
    "Options:",
    "  --agent <name>    Agent Dev Loop Target. Required when multiple Agents are compatible.",
    "  -p, --prompt <text>  Prompt text for a one-shot invocation.",
    "  --trigger <id>    Agent Trigger to invoke. Defaults to chat.message when available.",
    "  --cli <name>      Run a Capability CLI command attached to the Agent.",
    "  --payload <path>  Agent Trigger payload JSON file.",
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

function writeDevText(context: AgentCliContext, value: unknown): boolean {
  const text = formatDevPayload(value)
  if (text === undefined) return false
  context.stderr.write(text.endsWith("\n") ? text : `${text}\n`)
  return true
}

function deliveryPreviewPayload(value: unknown): { label: string, value: unknown } | undefined {
  if (typeof value === "string") return { label: "payload", value: value.trim() }
  if (!isRecord(value)) return value === undefined ? undefined : { label: "payload", value }
  for (const label of ["body", "text", "markdown"]) {
    const text = value[label]
    if (typeof text === "string") return { label, value: text.trim() }
  }
  return { label: "payload", value }
}

function writeDeliveryPreviewPayload(context: AgentCliContext, value: unknown): void {
  const preview = deliveryPreviewPayload(value)
  if (!preview) return
  writeDevPayload(context, preview.label, preview.value)
}

function deliveryReactionContent(payload: unknown): string | undefined {
  if (typeof payload === "string") return payload
  return isRecord(payload) && typeof payload.content === "string" ? payload.content : undefined
}

function deliveryReactionAction(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.action === "string" ? payload.action : undefined
}

function deliveryTitleContent(payload: unknown): string | undefined {
  if (typeof payload === "string") return payload.trim()
  return isRecord(payload) && typeof payload.title === "string" ? payload.title.trim() : undefined
}

function isRedundantDeliveryTitlePayload(payload: unknown): boolean {
  if (!deliveryTitleContent(payload)) return false
  return typeof payload === "string" || (isRecord(payload) && Object.keys(payload).length === 1)
}

function deliveryPreviewHeader(event: { channelId?: string, effect: { kind: string, payload?: unknown } }): string {
  const channel = event.channelId ? ` on ${event.channelId}` : ""
  if (event.effect.kind === "reaction") {
    const content = deliveryReactionContent(event.effect.payload)
    if (deliveryReactionAction(event.effect.payload) === "remove") return `[delivery] remove reaction${content ? ` ${content}` : ""}${channel}`
    return `[delivery] reaction${content ? ` ${content}` : ""}${channel}`
  }
  if (event.effect.kind === "title") {
    const title = deliveryTitleContent(event.effect.payload)
    return `[delivery] title${title ? ` ${title}` : ""}${channel}`
  }
  return `[delivery preview] would ${event.effect.kind}${channel}`
}

function deliveryPreviewArtifacts(effect: { artifacts?: unknown, payload?: unknown }): Array<Record<string, unknown>> {
  const artifacts = [
    ...(Array.isArray(effect.artifacts) ? effect.artifacts : []),
    ...(isRecord(effect.payload) && Array.isArray(effect.payload.artifacts) ? effect.payload.artifacts : []),
  ]
  return artifacts.filter(isRecord)
}

function writeDeliveryPreviewArtifacts(context: AgentCliContext, event: { channelId?: string, effect: { artifacts?: unknown, payload?: unknown } }): void {
  const channel = event.channelId ? ` on ${event.channelId}` : ""
  for (const artifact of deliveryPreviewArtifacts(event.effect)) {
    const path = typeof artifact.path === "string" ? artifact.path : "artifact"
    const label = artifact.placement === "attachment" ? "attachment" : "asset"
    context.stderr.write(`\n[delivery] ${label} ${path}${channel}\n`)
    writeDevPayload(context, "url", artifact.url)
    writeDevPayload(context, "attachment", artifact.channelAttachmentId)
  }
}

function toolTextOutput(value: unknown, seen = new Set<unknown>()): string | undefined {
  if (!isRecord(value) || seen.has(value)) return
  seen.add(value)
  if (typeof value.text === "string" && value.text.trim()) return value.text
  for (const key of ["output", "result", "raw"]) {
    const text = toolTextOutput(value[key], seen)
    if (text) return text
  }
}

function thinkingFallback(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata || !Object.hasOwn(metadata, "thinkingFallback")) return "Thinking..."
  const value = metadata.thinkingFallback
  return typeof value === "string" && value.trim() ? value : undefined
}

function usageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined
}

function formatDurationMs(durationMs: unknown): string | undefined {
  const finite = usageNumber(durationMs)
  if (finite === undefined) return
  return finite < 1000 ? `${finite}ms` : `${(finite / 1000).toFixed(1)}s`
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

function formatUsageDuration(durationMs: unknown): string | undefined {
  const finite = usageNumber(durationMs)
  if (finite === undefined) return
  return `${(finite / 1000).toFixed(1)}s`
}

function formatUsageCost(cost: AgentUsageRecord["cost"]): string | undefined {
  if (!cost?.amount) return
  const amount = cost.amount.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "")
  return `${cost.estimated ? "~" : ""}${cost.currency === "USD" ? `$${amount}` : `${amount} ${cost.currency}`}`
}

function formatUsageSpeed(record: AgentUsageRecord, durationMs?: number): string | undefined {
  const explicit = typeof record.latency?.tokensPerSecond === "number" && Number.isFinite(record.latency.tokensPerSecond)
    ? record.latency.tokensPerSecond
    : undefined
  const duration = usageNumber(record.latency?.durationMs) ?? durationMs
  const durationSeconds = duration === undefined ? undefined : duration / 1000
  const input = usageNumber(record.usage?.inputTokens)
  const output = usageNumber(record.usage?.outputTokens)
  const total = usageNumber(record.usage?.totalTokens)
  const outputOrTotal = output ?? (input !== undefined && total !== undefined ? total - input : total)
  const derived = explicit ?? (durationSeconds !== undefined && durationSeconds > 0 ? (outputOrTotal ?? 0) / durationSeconds : undefined)
  return derived && Number.isFinite(derived) ? `${derived.toFixed(1)} tok/s` : undefined
}

function formatUsageRecord(record: AgentUsageRecord, fallbackDurationMs?: number): string | undefined {
  const usage = record.usage
  const input = usageNumber(usage?.inputTokens)
  const output = usageNumber(usage?.outputTokens)
  const total = usageNumber(usage?.totalTokens) ?? (input !== undefined && output !== undefined ? input + output : undefined)
  const reasoning = readUsageDetail(usage?.outputTokenDetails, usage?.inputTokenDetails, usage?.details)
  const cost = formatUsageCost(record.cost)
  const duration = formatUsageDuration(record.latency?.durationMs ?? fallbackDurationMs)
  const speed = formatUsageSpeed(record, fallbackDurationMs)
  const parts: string[] = []
  if (cost) parts.push(`cost ${cost}`)
  if (total !== undefined) {
    const tokens = `${formatUsageNumber(total)} tokens`
    parts.push(input !== undefined && output !== undefined ? `${tokens}: ${formatUsageNumber(input)} in / ${formatUsageNumber(output)} out` : tokens)
  }
  else if (input !== undefined || output !== undefined) {
    parts.push([input !== undefined ? `${formatUsageNumber(input)} in` : undefined, output !== undefined ? `${formatUsageNumber(output)} out` : undefined].filter(Boolean).join(" / "))
  }
  if (reasoning !== undefined) parts.push(`${formatUsageNumber(reasoning)} reasoning tokens`)
  if (duration) parts.push(`time ${duration}`)
  if (speed) parts.push(`speed ${speed}`)
  return parts.length ? parts.join("; ") : undefined
}

function formatUsageNote(summary: string): string {
  return ["> [!NOTE]", `> Usage: ${summary}`].join("\n")
}

async function enrichUsageCost(record: AgentUsageRecord): Promise<AgentUsageRecord> {
  if (record.cost || !record.usage) return record
  try {
    const cost = await defaultDevUsagePricing()({
      model: record.model,
      response: record.response,
      run: record.run,
      usage: record.usage,
    })
    return cost ? { ...record, cost } : record
  }
  catch {
    return record
  }
}

function shellCommand(value: unknown): string | undefined {
  if (!isRecord(value)) return
  const raw = typeof value.command === "string"
    ? value.command
    : typeof value.cmd === "string"
      ? value.cmd
      : isRecord(value.args) && typeof value.args.command === "string"
        ? value.args.command
        : undefined
  if (typeof raw !== "string") return
  const command = raw.trim()
  return command && !command.includes("\n") ? command : undefined
}

function quoteCliValue(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (!text) return
  return /^[\w./:@=-]+$/.test(text)
    ? text
    : `'${text.replace(/'/g, "'\\''")}'`
}

function quoteCliPart(value: unknown): string | undefined {
  const quoted = quoteCliValue(value)
  return quoted && !quoted.includes("\n") ? quoted : undefined
}

function operationCommand(name: string, value: unknown): string | undefined {
  if (!isRecord(value)) return
  const operation = typeof value.operationId === "string" && value.operationId.trim()
    ? value.operationId.trim()
    : typeof value.operation === "string" && value.operation.trim()
      ? value.operation.trim()
      : undefined
  const quotedOperation = quoteCliPart(operation)
  if (!quotedOperation) return

  const parts = [name, quotedOperation]
  for (const key of ["path", "query", "body"]) {
    if (value[key] === undefined) continue
    const quoted = quoteCliPart(value[key])
    if (!quoted) return
    parts.push(`--${key}`, quoted)
  }

  const rest = Object.fromEntries(Object.entries(value).filter(([key, item]) =>
    item !== undefined && !["operation", "operationId", "path", "query", "body"].includes(key),
  ))
  if (Object.keys(rest).length) {
    const quotedRest = quoteCliPart(rest)
    if (!quotedRest) return
    parts.push("--input", quotedRest)
  }

  return parts.join(" ")
}

function argvCommand(name: string, value: unknown): string | undefined {
  if (!isRecord(value)) return
  const argv = value.argv
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== "string")) return
  const parts = [name]
  for (const arg of argv) {
    const quoted = quoteCliPart(arg)
    if (!quoted) return
    parts.push(quoted)
  }
  if (value.json === true && !argv.includes("--json")) parts.push("--json")
  if (value.input !== undefined && !argv.includes("--input") && !argv.some(arg => arg.startsWith("--input="))) {
    const quoted = quoteCliPart(JSON.stringify(value.input))
    if (!quoted) return
    parts.push("--input", quoted)
  }
  return parts.join(" ")
}

function toolCommand(name: string, input?: unknown, output?: unknown): string | undefined {
  return shellCommand(input)
    ?? shellCommand(output)
    ?? argvCommand(name, input)
    ?? argvCommand(name, output)
    ?? operationCommand(name, input)
    ?? operationCommand(name, output)
}

function toolHeader(name: string, input?: unknown, output?: unknown): string {
  const command = toolCommand(name, input, output)
  if (command) return `[tool] ${command}`

  const formattedInput = isRecord(input) && Object.keys(input).length === 0 ? undefined : formatDevPayload(input)
  return `[tool] ${name}${formattedInput ? ` ${formattedInput}` : ""}`
}

function writeToolDuration(context: AgentCliContext, durationMs: unknown): void {
  const duration = formatDurationMs(durationMs)
  if (duration) context.stderr.write(`  duration: ${duration}\n`)
}

function writeShellOutput(context: AgentCliContext, output: unknown, error: unknown, durationMs?: number): boolean {
  if (!isRecord(output)) return false
  const stdout = typeof output.stdout === "string" && output.stdout ? output.stdout : undefined
  const stderr = typeof output.stderr === "string" && output.stderr ? output.stderr : undefined
  if (!stdout && !stderr && error === undefined) return false
  if (stdout) writeDevText(context, stdout)
  if (stderr) writeDevPayload(context, "stderr", stderr)
  writeDevPayload(context, "error", error)
  writeToolDuration(context, durationMs)
  context.stderr.write("---\n")
  return true
}

function writeToolTextOutput(context: AgentCliContext, output: unknown, durationMs?: number): boolean {
  const text = toolTextOutput(output)
  if (!text) return false
  writeDevText(context, text)
  writeToolDuration(context, durationMs)
  context.stderr.write("---\n")
  return true
}

function progressTag(phase: string): string {
  if (phase.startsWith("agent.harness")) return "harness"
  return phase.startsWith("workspace.") ? "workspace" : "internal"
}

function writeProgress(context: AgentCliContext, event: { data?: Record<string, unknown>, durationMs?: number, label?: string, phase: string, status: "completed" | "failed" | "started" | "updating" }): void {
  const duration = formatDurationMs(event.durationMs)
  const status = event.status === "started" ? "" : ` ${event.status}`
  context.stderr.write(`\n[${progressTag(event.phase)}] ${event.label || event.phase}${status}${duration ? ` (${duration})` : ""}\n`)
  if (event.status === "failed") writeDevPayload(context, "error", event.data?.error)
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
  options: AgentEvalOptions | undefined,
  runner?: EvaliteRunner,
  writeConfig: AgentEvaliteConfigWriter = writeAgentEvaliteConfig,
  include?: string[],
): Promise<number> {
  const resolvedOptions = resolveAgentEvalOptions(options)

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
    ...(include ? { include } : {}),
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
    if (arg === "--cli") {
      parsed.cli = readOptionValue(args, index, arg)
      index++
      continue
    }
    if (arg.startsWith("--cli=")) {
      parsed.cli = arg.slice("--cli=".length)
      continue
    }
    if (arg === "--") {
      if (!parsed.cli) throw new Error("-- separates Capability CLI arguments and requires --cli.")
      parsed.cliArgv = args.slice(index + 1)
      break
    }
    if (arg === "--payload") {
      parsed.payloadPath = readOptionValue(args, index, arg)
      index++
      continue
    }
    if (arg.startsWith("--payload=")) {
      parsed.payloadPath = arg.slice("--payload=".length)
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
    if (!parsed.agent && !parsed.message && message.length === 0 && args[index + 1]?.startsWith("!")) {
      parsed.agent = arg
      continue
    }
    if (arg.startsWith("!")) {
      message.push(...args.slice(index))
      parsed.workspaceCommand = directWorkspaceCommandArgv(args.slice(index))
      break
    }
    message.push(arg)
  }

  const text = message.join(" ").trim()
  if (text && parsed.message) throw new Error("Pass either --prompt or message text, not both.")
  if (parsed.cli && (text || parsed.message || parsed.trigger)) {
    throw new Error("Pass either --cli or Agent message/trigger input, not both.")
  }
  if (text) parsed.message = text
  return parsed
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

async function readDevPayloadFile(path: string): Promise<{ path: string, value: Record<string, unknown> }> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown
  if (!isRecord(value)) {
    throw new Error("Agent Dev Loop payload file must contain a JSON object.")
  }
  return { path, value }
}

async function loadDevPayload(payloadPath: string, rootDir: string, cwd: string): Promise<{ path: string, value: Record<string, unknown> }> {
  const rootPath = resolve(rootDir, payloadPath)
  try {
    return await readDevPayloadFile(rootPath)
  }
  catch (error) {
    const cwdPath = resolve(cwd, payloadPath)
    if (!isFileNotFound(error) || cwdPath === rootPath) throw error
    return await readDevPayloadFile(cwdPath)
  }
}

function endpointUrl(baseUrl: string): string {
  return new URL(agentInvocationStreamRoute, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href
}

async function readDiscovery(
  parsed: ParsedDevArgs,
  context: AgentCliContext,
  fetchImpl: typeof fetch,
): Promise<AgentDevTarget | undefined> {
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

  const discovery = await response.json().catch(() => ({})) as Partial<AgentDevLoopDiscoveryResponse>
  if (typeof discovery.root === "string" && discovery.root !== context.rootDir) {
    context.stderr.write(`Compatible Vite Development Server root mismatch: ${discovery.root}\n`)
    return
  }
  const tokenOptions = typeof discovery.workspaceDevTokenServerId === "string" ? { serverId: discovery.workspaceDevTokenServerId } : {}
  const agents = (discovery.agents || []).flatMap(agent => typeof agent.name === "string" ? [agent.name] : [])
  const agentTargets = new Map<string, string>()
  for (const agent of discovery.agents || []) {
    if (typeof agent.name !== "string") continue
    agentTargets.set(agent.name, agent.name)
    if (Array.isArray(agent.aliases)) {
      for (const alias of agent.aliases) {
        if (typeof alias === "string") agentTargets.set(alias, alias)
      }
    }
  }
  if (parsed.agent) {
    const target = agentTargets.get(parsed.agent)
    if (!target) {
      context.stderr.write(`Unknown Agent Dev Loop Target: ${parsed.agent}\n`)
      return
    }
    return { agent: target, tokenOptions, url }
  }
  if (agents.length === 1) {
    return { agent: agents[0]!, tokenOptions, url }
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
  const startedAt = Date.now()
  let response: Response
  try {
    response = await fetchImpl(url, {
      body: JSON.stringify({
        agent,
        ...(messages.length ? { messages } : {}),
        ...(parsed.payload ? { payload: parsed.payload } : {}),
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
    context.stderr.write(`${formatAgentError(error, "Agent Dev Loop request failed.")}\n`)
    return
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
  let fallbackTimer: ReturnType<typeof setInterval> | undefined
  let lastUsageRecord: AgentUsageRecord | undefined
  let wroteUsageNote = false
  let finishSeen = false
  let previewSeen = false
  const visibleTools = new Set<string>()
  const visibleToolInputs = new Map<string, string | undefined>()
  const visibleToolStarts = new Map<string, number>()
  const writeUsageNote = () => {
    if (previewSeen) return
    if (!lastUsageRecord || wroteUsageNote) return
    const usage = formatUsageRecord(lastUsageRecord, Date.now() - startedAt)
    if (!usage) return
    context.stdout.write(`${output && !output.endsWith("\n") ? "\n" : ""}\n${formatUsageNote(usage)}\n`)
    wroteUsageNote = true
  }
  const clearPendingFallback = () => {
    if (fallbackTimer) {
      clearInterval(fallbackTimer)
      fallbackTimer = undefined
    }
    if (!pendingFallback) return
    context.stderr.write("\r\u001b[K\u001B[?25h")
    pendingFallback = false
  }
  const startFallback = (fallback: string) => {
    const base = fallback.trim().replace(/\.+$/, "")
    const frames = [".", "..", "..."]
    let frame = 2
    const write = () => {
      context.stderr.write(`\r${base}${frames[frame++ % frames.length]}`)
    }
    context.stderr.write("\u001B[?25l")
    write()
    fallbackTimer = setInterval(write, 250)
    ;(fallbackTimer as { unref?: () => void }).unref?.()
    pendingFallback = true
  }
  try {
    for await (const event of readAgentInvocationStream(response.body)) {
      if (event.type === "start") {
        if (wroteFallback) continue
        const fallback = thinkingFallback(event.metadata)
        if (fallback) startFallback(fallback)
        wroteFallback = true
        continue
      }
      if (event.type === "text-delta") {
        clearPendingFallback()
        output += event.text
        context.stdout.write(event.text)
        continue
      }
      if (event.type === "tool-call" || event.type === "tool-input-start") {
        clearPendingFallback()
        if (event.type === "tool-input-start" && event.input === undefined) continue
        visibleToolStarts.set(event.id, visibleToolStarts.get(event.id) ?? Date.now())
        if (!visibleTools.has(event.id)) {
          visibleTools.add(event.id)
          visibleToolInputs.set(event.id, toolCommand(event.name, event.input) ?? formatDevPayload(event.input))
          context.stderr.write(`\n${toolHeader(event.name, event.input)}\n`)
        }
        else if (event.input !== undefined) {
          const command = toolCommand(event.name, event.input)
          if (command) {
            if (command !== visibleToolInputs.get(event.id)) {
              visibleToolInputs.set(event.id, command)
              context.stderr.write(`\n[tool] ${command}\n`)
            }
            continue
          }
          const formattedInput = formatDevPayload(event.input)
          if (formattedInput !== visibleToolInputs.get(event.id)) {
            visibleToolInputs.set(event.id, formattedInput)
            writeDevPayload(context, "input", event.input)
          }
        }
        continue
      }
      if (event.type === "tool-result") {
        clearPendingFallback()
        const startedAt = visibleToolStarts.get(event.id)
        const durationMs = usageNumber(event.durationMs) ?? (startedAt === undefined ? undefined : Date.now() - startedAt)
        if (!visibleTools.has(event.id)) {
          visibleTools.add(event.id)
          context.stderr.write(`\n${toolHeader(event.name, undefined, event.output)}\n`)
        }
        visibleToolInputs.delete(event.id)
        visibleToolStarts.delete(event.id)
        if (!writeShellOutput(context, event.output, event.error, durationMs) && !writeToolTextOutput(context, event.output, durationMs)) {
          writeDevPayload(context, "output", event.output)
          writeDevPayload(context, "error", event.error)
          writeToolDuration(context, durationMs)
        }
        continue
      }
      if (event.type === "progress") {
        clearPendingFallback()
        writeProgress(context, event)
        continue
      }
      if (event.type === "usage") {
        clearPendingFallback()
        lastUsageRecord = await enrichUsageCost(event.usageRecord)
        if (finishSeen) writeUsageNote()
        continue
      }
      if (event.type === "finish" || event.type === "done") {
        clearPendingFallback()
        finishSeen = true
        writeUsageNote()
        continue
      }
      if (event.type === "delivery-preview") {
        clearPendingFallback()
        previewSeen = true
        writeDeliveryPreviewArtifacts(context, event)
        context.stderr.write(`\n${deliveryPreviewHeader(event)}\n`)
        writeDevPayload(context, "intent", event.effect.intent)
        if (event.effect.kind !== "reaction" && (event.effect.kind !== "title" || !isRedundantDeliveryTitlePayload(event.effect.payload))) {
          writeDeliveryPreviewPayload(context, event.effect.payload)
        }
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
        context.stderr.write(`\n${formatAgentError(event.error, "Agent Invocation Stream failed.")}\n`)
        return
      }
    }
  }
  catch (error) {
    clearPendingFallback()
    if (signal?.aborted || error instanceof DOMException && error.name === "AbortError") {
      context.stderr.write("\n[aborted]\n")
      return history
    }
    context.stderr.write(`\n${formatAgentError(error, "Agent Invocation Stream failed.")}\n`)
    return
  }
  clearPendingFallback()
  if (output) context.stdout.write("\n")
  if (!output && needsApproval) return
  return messages.length || output ? [...messages, assistantMessage(output, messages.length)] : []
}

async function sendDevCliCommand(
  url: string,
  agent: string,
  parsed: ParsedDevArgs,
  context: AgentCliContext,
  fetchImpl: typeof fetch,
): Promise<number> {
  const response = await fetchImpl(url, {
    body: JSON.stringify({
      agent,
      ...(parsed.payload ? { payload: parsed.payload } : {}),
      ...(parsed.timeout ? { timeout: parsed.timeout } : {}),
      cli: {
        argv: parsed.cliArgv || [],
        name: parsed.cli,
      },
    }),
    headers: {
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
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

async function sendDevWorkspaceCommand(
  url: string,
  agent: string,
  command: WorkspaceCommandInput,
  parsed: ParsedDevArgs,
  context: AgentCliContext,
  fetchImpl: typeof fetch,
  tokenOptions: WorkspaceDevTokenOptions,
  signal?: AbortSignal,
): Promise<number> {
  const token = await readWorkspaceDevToken(context.rootDir, tokenOptions)
  if (!token) {
    context.stderr.write("No private Agent Dev Loop command token found. Start the Compatible Vite Development Server first.\n")
    return 1
  }
  const startedAt = Date.now()
  const stopFeedback = startWorkspaceCommandFeedback(context)
  try {
    const response = await fetchImpl(url, {
      body: JSON.stringify({
        agent,
        ...(parsed.payload ? { payload: parsed.payload } : {}),
        ...(parsed.timeout ? { timeout: parsed.timeout } : {}),
        workspaceCommand: {
          ...(command.args ? { args: command.args } : {}),
          command: command.command,
          ...(parsed.timeout ? { timeout: parsed.timeout } : {}),
        },
      }),
      headers: {
        "content-type": "application/json",
        [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
        [workspaceDevTokenHeader]: token,
      },
      method: "POST",
      signal,
    })
    if (!response.ok) {
      context.stderr.write(`${await response.text()}\n`)
      return 1
    }
    const result = await response.json().catch(() => ({})) as { exitCode?: unknown, stderr?: unknown, stdout?: unknown }
    if (typeof result.stdout === "string") context.stdout.write(result.stdout)
    if (typeof result.stderr === "string" && result.stderr) context.stderr.write(result.stderr)
    context.stderr.write(`[workspace] command completed (${formatDurationMs(Date.now() - startedAt)})\n`)
    return typeof result.exitCode === "number" ? result.exitCode : 0
  }
  catch (error) {
    if (signal?.aborted || error instanceof DOMException && error.name === "AbortError") {
      context.stderr.write("\n[aborted]\n")
      return 0
    }
    throw error
  }
  finally {
    stopFeedback()
  }
}

function directWorkspaceCommand(text: string): string | undefined {
  if (!text.startsWith("!")) return
  const command = text.slice(1).trim()
  return command || undefined
}

function directWorkspaceCommandArgv(args: string[]): WorkspaceCommandInput | undefined {
  const [rawCommand, ...rest] = args
  if (!rawCommand?.startsWith("!")) return
  const command = rawCommand.slice(1).trim()
  if (!command) return
  return {
    ...(rest.length ? { args: rest } : {}),
    command,
  }
}

async function runInteractiveDevLoop(
  parsed: ParsedDevArgs,
  context: AgentCliContext,
  fetchImpl: typeof fetch,
  target: AgentDevTarget,
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
      const command = directWorkspaceCommand(text)
      if (command) {
        activeRequest = new AbortController()
        try {
          const exitCode = await sendDevWorkspaceCommand(target.url, target.agent, { command }, parsed, context, fetchImpl, target.tokenOptions, activeRequest.signal)
          if (exitCode !== 0) return exitCode
          continue
        }
        finally {
          activeRequest = undefined
        }
      }
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
  const workspaceCommand = parsed.workspaceCommand
  if (parsed.payloadPath) {
    try {
      const loaded = await loadDevPayload(parsed.payloadPath, context.rootDir, context.cwd)
      parsed.payload = loaded.value
      const output = parsed.cli || workspaceCommand ? context.stderr : context.stdout
      output.write(`Loaded payload: ${loaded.path}\n`)
    }
    catch (error) {
      context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  const fetchImpl = options.fetch || globalThis.fetch
  const target = await readDiscovery(parsed, context, fetchImpl)
  if (!target) return 1

  if (parsed.cli) {
    return await sendDevCliCommand(target.url, target.agent, parsed, context, fetchImpl)
  }
  if (workspaceCommand) {
    return await sendDevWorkspaceCommand(target.url, target.agent, workspaceCommand, parsed, context, fetchImpl, target.tokenOptions)
  }

  const payloadStartsInvocation = parsed.payload && (
    parsed.trigger && parsed.trigger !== "chat.message"
    || Array.isArray(parsed.payload.messages) && parsed.payload.messages.length > 0
  )
  if (parsed.message || payloadStartsInvocation) {
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
  const evalRoots = [
    options?.rootDir ?? process.cwd(),
    ...(options?.serverDirs ?? []),
  ]
  const evalFiles = discoverAgentEvalFiles(evalRoots)
  const features: AgentCliContributor["namespaces"][number]["features"] = [
    {
      description: "Inspect a discovered Agent through a running Vite Development Server.",
      name: "info",
      run: async (args, context) => await runAgentInfoCli(args, context),
      usage: "vitehub agent info [--agent <name>] [--json]",
    },
    {
      description: "Talk to a discovered Agent through a running Vite Development Server.",
      name: "dev",
      run: async (args, context) => await runAgentDevCli(args, context),
      usage: "vitehub agent dev [message...] [--agent <name>]",
    },
  ]
  if (evalFiles.length) {
    features.unshift({
      description: "Run ViteHub Agent Evals.",
      name: "eval",
      run: async (args, context) => await runAgentEvalCli(
        args,
        context,
        evalOptions,
        undefined,
        writeAgentEvaliteConfig,
        createAgentEvalInclude(evalRoots),
      ),
      usage: "vitehub agent eval [path] [--watch]",
    })
  }
  return {
    namespaces: [
      {
        description: "Agent development workflows.",
        features,
        name: "agent",
      },
      {
        description: "External Channel registration workflows.",
        features: [{
          description: "Inspect and synchronize provider-owned Channel webhooks for a deployed stage.",
          name: "sync",
          run: async (args, context) => await runAgentChannelSyncCli(args, context, {
            rootDir: options?.rootDir,
            serverDirs: options?.serverDirs,
          }),
          usage: "vitehub channels sync --stage <name> --url <https-origin> [--apply --confirm-origin <https-origin>]",
        }],
        name: "channels",
      },
    ],
  }
}

export { runAgentInfoCli }
