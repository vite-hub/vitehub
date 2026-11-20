import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { findViteHubDevServerUrl } from "@vite-hub/internal/cli"
import { formatRuntimeDiagnosticError } from "@vite-hub/runtime"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } from "../invocation-stream.ts"
import { emulatorUrlEnv } from "./agent-emulation.ts"
import { isRuntimeRecord } from "./runtime-type.ts"

interface AgentEmulatorCliContext {
  env: NodeJS.ProcessEnv
  rootDir: string
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface AgentEmulatorCliOptions {
  fetch?: typeof fetch
  timeout?: number
}

interface ParsedEmulatorArgs {
  help: boolean
  json: boolean
  url?: string
}

/** One rule of upstream `GET /_ai/rules`. `remaining` is `null` for a rule without `times`. */
interface EmulatorRule {
  id: string
  remaining?: number | null
  times?: number
  reply?: unknown
  variants?: unknown
  error?: unknown
}

/** One call of upstream `GET /_ai/calls`. `matched` is a rule, a default, or `null` when strict mode rejected it. */
interface EmulatorCall {
  seq?: number
  time?: string
  format?: string
  model?: string
  status?: number
  matched?: { id?: string, default?: string } | null
}

/** How many of the most recent calls the table shows. `--json` prints all of them. */
const recentCalls = 10

function writeUsage(context: AgentEmulatorCliContext): void {
  context.stdout.write([
    "Usage: vitehub agent emulator [--url <url>] [--json]",
    "",
    "Show the AI emulator that answers Agent models under VITEHUB_MODELS=emulate: its URL, its rules with the",
    "budget that is left, and its recent calls with the rule that answered each one.",
    "",
    "Options:",
    "  --url <url>  App URL of a dev server that runs the emulator, such as http://localhost:3000.",
    "               Without it, the command reads VITEHUB_EMULATE_URL, then asks the dev server of this project.",
    "  --json       Print the upstream /_ai/rules and /_ai/calls responses with the emulator URL.",
    "  -h, --help   Show this help.",
    "",
  ].join("\n"))
}

function parseArgs(args: string[]): ParsedEmulatorArgs {
  const parsed: ParsedEmulatorArgs = { help: false, json: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--json") parsed.json = true
    else if (arg === "--url") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) throw agentDiagnostics.AGENT_R0498({ message: `Missing value for ${arg}.` })
      parsed.url = value
      index++
    }
    else if (arg.startsWith("--url=")) {
      const value = arg.slice("--url=".length)
      if (!value) throw agentDiagnostics.AGENT_R0498({ message: `Missing value for ${arg}.` })
      parsed.url = value
    }
    else if (arg.startsWith("-")) throw agentDiagnostics.AGENT_R0499({ message: `Unknown option: ${arg}.` })
    else throw agentDiagnostics.AGENT_R0500({ message: `Unexpected argument: ${arg}.` })
  }
  return parsed
}

/** The emulator URL that the dev server at `app` reports in its Agent Dev Loop discovery, or undefined. */
async function devServerEmulatorUrl(app: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<string | undefined> {
  const endpoint = new URL(agentInvocationStreamRoute, app.endsWith("/") ? app : `${app}/`)
  const response = await fetchImpl(endpoint.href, {
    redirect: "manual",
    headers: { accept: "application/json", [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue },
    signal,
  })
  if (!response.ok) {
    await response.body?.cancel()
    return
  }
  const discovery: unknown = await response.json().catch(() => undefined)
  if (!isRuntimeRecord(discovery) || !isRuntimeRecord(discovery.emulator)) return
  return typeof discovery.emulator.url === "string" && discovery.emulator.url ? discovery.emulator.url : undefined
}

/** Finds the emulator: `--url` asks that dev server, else `VITEHUB_EMULATE_URL`, else the dev server of this project. */
async function findEmulatorUrl(parsed: ParsedEmulatorArgs, context: AgentEmulatorCliContext, fetchImpl: typeof fetch, signal: AbortSignal): Promise<string> {
  const fromEnv = context.env[emulatorUrlEnv]
  if (!parsed.url && fromEnv) return fromEnv
  const app = parsed.url ?? findViteHubDevServerUrl([...new Set([context.rootDir, resolveViteHubProjectRoot(context.rootDir)])], context.env)
  if (!app) throw agentDiagnostics.AGENT_EMULATOR_NOT_RUNNING({ where: `${emulatorUrlEnv} is not set, and no dev server of this project is running` })
  const url = await devServerEmulatorUrl(app, fetchImpl, signal).catch((error: unknown) => {
    if (error instanceof Error && error.name === "TimeoutError") throw error
    return undefined
  })
  if (!url) throw agentDiagnostics.AGENT_EMULATOR_NOT_RUNNING({ where: `the dev server at ${app} does not run one` })
  return url
}

async function readControl(url: string, path: "/_ai/calls" | "/_ai/rules", fetchImpl: typeof fetch, signal: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(new URL(path, url).href, { headers: { accept: "application/json" }, signal })
  }
  catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw error
    throw agentDiagnostics.AGENT_EMULATOR_NOT_RUNNING({ where: `at ${url}`, cause: error })
  }
  const body: unknown = response.ok ? await response.json().catch(() => undefined) : undefined
  if (body === undefined) throw agentDiagnostics.AGENT_EMULATOR_NOT_RUNNING({ where: `at ${url} (GET ${path} returned ${response.status})` })
  return body
}

function rulesOf(value: unknown): EmulatorRule[] {
  if (!isRuntimeRecord(value) || !Array.isArray(value.rules)) return []
  // SAFETY: Upstream `GET /_ai/rules` returns the rules in the shape that `PUT /_ai/rules` accepts, each with an `id`.
  return value.rules.filter(isRuntimeRecord) as unknown as EmulatorRule[]
}

function callsOf(value: unknown): EmulatorCall[] {
  // SAFETY: Upstream `GET /_ai/calls` returns a bare array of call records. The table reads only optional fields.
  return Array.isArray(value) ? value.filter(isRuntimeRecord) as unknown as EmulatorCall[] : []
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => `  ${row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")}`.trimEnd())
}

function ruleKind(rule: EmulatorRule): string {
  if (rule.error !== undefined) return "error"
  if (rule.variants !== undefined) return "variants"
  return "reply"
}

function ruleBudget(rule: EmulatorRule): string {
  if (rule.remaining === null || rule.remaining === undefined) return "unlimited"
  return typeof rule.times === "number" ? `${rule.remaining} of ${rule.times}` : String(rule.remaining)
}

function callRule(call: EmulatorCall): string {
  if (call.matched === null) return "none (strict)"
  if (call.matched?.id) return call.matched.id
  if (call.matched?.default) return `default (${call.matched.default})`
  return "unknown"
}

function callTime(call: EmulatorCall): string {
  return call.time?.match(/T(\d\d:\d\d:\d\d)/)?.[1] ?? ""
}

function writeSummary(context: AgentEmulatorCliContext, url: string, rulesBody: unknown, callsBody: unknown): void {
  const rules = rulesOf(rulesBody)
  const calls = callsOf(callsBody)
  const strict = isRuntimeRecord(rulesBody) && rulesBody.strict === true
  const shown = calls.slice(-recentCalls)
  context.stdout.write([
    `AI emulator: ${url}`,
    `Strict: ${strict ? "yes, a request that no rule matches fails" : "no, a request that no rule matches gets a default reply"}`,
    "",
    `Rules: ${rules.length}`,
    ...(rules.length ? table([["ID", "Left", "Answer"], ...rules.map(rule => [rule.id, ruleBudget(rule), ruleKind(rule)])]) : []),
    "",
    calls.length > shown.length ? `Calls: ${calls.length} (last ${shown.length} shown, --json prints all)` : `Calls: ${calls.length}`,
    ...(shown.length
      ? table([["#", "Time", "Model", "Format", "Status", "Rule"], ...shown.map(call => [String(call.seq ?? ""), callTime(call), call.model ?? "", call.format ?? "", String(call.status ?? ""), callRule(call)])])
      : []),
    "",
  ].join("\n"))
}

/** `vitehub agent emulator`: prints the URL, rules, and recent calls of the AI emulator. */
export async function runAgentEmulatorCli(args: string[], context: AgentEmulatorCliContext, options: AgentEmulatorCliOptions = {}): Promise<number> {
  let parsed: ParsedEmulatorArgs
  try {
    parsed = parseArgs(args)
  }
  catch (error) {
    context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
    writeUsage(context)
    return 1
  }
  if (parsed.help) {
    writeUsage(context)
    return 0
  }
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeout = options.timeout ?? 10_000
  const signal = AbortSignal.timeout(timeout)
  try {
    const url = await findEmulatorUrl(parsed, context, fetchImpl, signal)
    const [rules, calls] = await Promise.all([
      readControl(url, "/_ai/rules", fetchImpl, signal),
      readControl(url, "/_ai/calls", fetchImpl, signal),
    ])
    if (parsed.json) context.stdout.write(`${JSON.stringify({ url, rules, calls }, null, 2)}\n`)
    else writeSummary(context, url, rules, calls)
    return 0
  }
  catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") context.stderr.write(`The AI emulator did not answer within ${timeout}ms.\n`)
    else context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
    return 1
  }
}
