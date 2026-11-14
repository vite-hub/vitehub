import { existsSync } from "node:fs"
import { basename, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { asUnknownBoundary, isRuntimeRecord } from "./runtime-type.ts"
import { discoverViteHubDevServer, fetchViteHubDevEndpoint, readViteHubDevTargetOption, resolveViteHubDevServerUrl } from "@vite-hub/internal/cli"
import { callOperationRpc, type OperationRpcOutcome } from "@vite-hub/internal/operation-rpc"
import { invocationOperationNames, operationCredentialHint, operationRpcPath, signedOperationHeaders } from "@vite-hub/internal/operations"
import { agentInvocationsDevGuard, agentInvocationsDevRoute, agentInvocationsDevRuntimeUnavailableMessage, agentInvocationsDevTokenServerHeader } from "../invocations-dev.ts"
import { readWorkspaceDevToken, workspaceDevTokenHeader } from "@vite-hub/workspace/server"
import { isCompatibleAgentDevServerRoot } from "./agent-info-cli.ts"
import type { AgentInvocationCancelResult, AgentInvocationListResult, AgentInvocationRecord, AgentInvocationStore } from "../invocations.ts"
import type { AgentInvocationsDevRequestBody } from "../invocations-dev.ts"
import type { AgentInvocationDetailResult } from "../invocations-vue.ts"
import { formatRuntimeDiagnosticError, type RuntimeDiagnosticError } from "@vite-hub/runtime"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { openAgentInvocationJournalFile } from "./agent-invocations-journal-file.ts"
import { compactJournalFile } from "./agent-invocations-compact.ts"
import type { JournalCompactResult, JournalFileMeasurement } from "./agent-invocations-compact.ts"
import { invocationActivityTrace } from "../invocations/activity.ts"
import { maxAgentInvocationListLimit } from "../invocations/list-options.ts"
import { defaultAgentInvocationsAuthTokenEnv, defaultAgentInvocationsPath, defaultAgentInvocationsUrlEnv } from "../invocations/default-location.ts"
import { formatRetentionPercentage, parseRetentionDuration, parseRetentionSize } from "./retention-policy.ts"
import type { RetentionSizeLimit } from "./retention-policy.ts"
import type { AgentRetentionPolicy } from "../retention.ts"

interface AgentInvocationsCliContext {
  env: NodeJS.ProcessEnv
  /** Project root that the Compatible Vite Development Server must serve. Defaults to the current directory. */
  rootDir?: string
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

export interface AgentInvocationsCliOptions {
  /** How long compact waits for the write lock before it fails. Defaults to 5000 ms. */
  compactBusyTimeoutMs?: number
  fetch?: typeof fetch
  /** Bytes that compact can write in a directory. Defaults to statfs. */
  freeSpace?: (directory: string) => Promise<number>
  sleep?: (milliseconds: number) => Promise<void>
  timeout?: number
}

type Action = "compact" | "delete" | "export" | "list" | "prune" | "show" | "tail" | "wait-idle"

const actions = new Set<string>(["compact", "delete", "export", "list", "prune", "show", "tail", "wait-idle"] satisfies Action[])
/** Actions that read or rebuild the whole journal instead of one record. */
const journalActions = new Set<string | undefined>(["compact", "export", "list", "prune", "wait-idle"])
function isAction(value: string): value is Action {
  return actions.has(value)
}

/** Actions that can read a journal file with --database instead of asking the app. */
const fileActions = new Set<string | undefined>(["export", "list", "show", "tail", "wait-idle"])

interface ParsedArgs {
  action?: Action | "cancel"
  /** export adds a compact activity trace. */
  activity: boolean
  /** wait-idle only waits on this Agent's Invocations. */
  /** export only prints this Agent's Invocations. */
  agent?: string
  /** The app URL from `--url`. list, show, tail, export, wait-idle, and cancel use the Console RPC under it. */
  console?: URL
  /** A localhost app URL. When no Console answers there, the old local meaning runs, with AGENT_R1053. */
  consoleFallback?: boolean
  /** An old `--url` form that still works for one minor version. The command reports it with AGENT_R1053. */
  deprecated?: { form: string, use: string }
  database?: string
  dryRun: boolean
  help: boolean
  id?: string
  interval: number
  json: boolean
  limit?: number
  /** export includes every observation. */
  observations: boolean
  /** Size limit for prune. Set by --max-size. */
  maxSize?: RetentionSizeLimit
  /** Count limit for prune. Set by --max-records. */
  maxRecords?: number
  olderThanMs?: number
  /** export only prints Invocations with this origin. */
  origin?: string
  /** export only prints Invocations created at or after this ISO time. */
  since?: string
  status?: string
  tablePrefix?: string
  timeout?: number
  url: string
  /** `--server` selects the Vite Development Server, never a Console. */
  server: boolean
  /** wait-idle ignores pending or running records last updated before this age. */
  staleAfter: number
  urlSet: boolean
  /** How long wait-idle waits. `timeout` stays the request timeout. */
  waitTimeout: number
}

const cancelEndpoint = { ...agentInvocationsDevGuard, route: agentInvocationsDevRoute }

interface AgentInvocationsDevDiscovery {
  message?: unknown
  root?: unknown
  runtime?: unknown
  workspaceDevTokenServerId?: unknown
}

function parseCancelDiscovery(value: unknown): AgentInvocationsDevDiscovery {
  if (!isRuntimeRecord(value) || typeof value.root !== "string" || typeof value.runtime !== "string"
    || (value.message !== undefined && typeof value.message !== "string")) {
    throw agentDiagnostics.AGENT_R0971({ message: "Invocation cancellation discovery returned an invalid response." })
  }
  const discovery: AgentInvocationsDevDiscovery = { root: value.root, runtime: value.runtime }
  if (value.message !== undefined) discovery.message = value.message
  if (value.workspaceDevTokenServerId !== undefined) discovery.workspaceDevTokenServerId = value.workspaceDevTokenServerId
  return discovery
}

const devTargetErrors = {
  invalidInlineTimeout: (message: string) => agentDiagnostics.AGENT_R0503({ message }),
  invalidTimeout: (message: string) => agentDiagnostics.AGENT_R0503({ message }),
  missingValue: (message: string) => agentDiagnostics.AGENT_R0502({ message }),
}

const defaultPruneAgeMs = 30 * 24 * 60 * 60 * 1000
const waitIdleDefaults = { interval: 5_000, staleAfter: 2 * 60 * 60 * 1000, timeout: 30 * 60 * 1000 }
const activeStatuses = ["pending", "running"] as const
const durationUnits: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, ms: 1, s: 1_000, w: 604_800_000 }

function usage(context: AgentInvocationsCliContext): void {
  context.stdout.write([
    "Usage: vitehub agent invocations <list|show|tail|export|wait-idle|cancel|delete|prune|compact> [id] [options]",
    "",
    "list, show, tail, and cancel inspect or control an application's Agent Invocation journal.",
    "wait-idle exits 0 once no Invocation is pending or running, and 1 when --timeout passes first.",
    "",
    "list, show, tail, and cancel inspect or control an application's Agent Invocation journal.",
    "export prints one JSON line per Invocation, oldest first, for offline analysis and evals.",
    "delete and prune remove completed, failed, and cancelled records from a SQLite or libSQL journal.",
    "compact rebuilds a local SQLite journal file with VACUUM, so it gives free pages back to the file system,",
    "and sets auto_vacuum = INCREMENTAL. It needs the write lock: stop the server or run it during a quiet window.",
    "With --url, list, show, tail, export, wait-idle, and cancel use the Console of that app. Without it,",
    "cancel asks a running Vite + Nitro Development Server to cancel a pending or running Invocation.",
    "With --database, list, show, tail, export, and wait-idle read a local SQLite journal file read-only, without the app.",
    "This command does not load the project config.",
    "",
    "Options:",
    "  --url <url>               App URL, such as https://app.example.com or http://localhost:3000, as in every",
    "                            vitehub command. Uses the Console RPC endpoint under it. Set",
    "                            VITEHUB_CONSOLE_PRIVATE_KEY_<NAME> to sign the calls to a deployment.",
    "                            Without --url, list, show, and tail read the invocation endpoint",
    "                            (default http://localhost:5173/api/invocations).",
    "  --server <url>            Vite Development Server URL for cancel. Defaults to VITEHUB_DEV_SERVER_URL or http://localhost:5173.",
    "  --timeout <ms>            Request timeout. Defaults to 30000. For wait-idle, how long to wait, such as 30m.",
    "                            Defaults to 30m.",
    "  --status <status>         Filter list results by pending, running, completed, failed, or cancelled.",
    "  --limit <count>           Limit list results.",
    "  --interval <ms>           Polling interval, such as 500 or 5s. Defaults to 1000 for tail and 5s for wait-idle.",
    "  --stale-after <duration>  wait-idle reports pending or running records last updated before this age, such as 2h,",
    "                            and does not wait on them. Defaults to 2h.",
    "  --agent <name>            wait-idle only waits on this Agent's Invocations.",
    "  --database <url>          Journal database for delete, prune, compact, export, and wait-idle. Defaults to the default journal file.",
    "                            list, show, and tail read this SQLite file read-only, such as the journal inside",
    "                            a running container. They do not migrate or write it.",
    "  --table-prefix <prefix>   Journal table prefix. Defaults to vitehub_agent_.",
    "  --older-than <duration>   Prune records last updated before this age, such as 12h or 7d. Defaults to 30d.",
    "  --max-records <count>     Prune the oldest records past this count. With --max-size, --older-than is",
    "                            optional and applies only when given.",
    "  --max-size <size>         Prune the oldest records until the live data of the database file fits this size,",
    "                            such as 500MB or a number of bytes, or this percent of its volume, such as 30%.",
    "                            The file shrinks only when it uses auto_vacuum = INCREMENTAL.",

    "  --dry-run                 List the records that prune would delete. For compact, print the file size, the",
    "                            projected size, and the free space check, and change nothing.",
    "  --origin <origin>         export only Invocations with this origin, such as webhook.",
    "  --agent <name>            export only this Agent's Invocations.",
    "  --since <duration|date>   export only Invocations created after this age or ISO date, such as 7d or 2026-10-01.",
    "  --observations            export every observation too.",
    "  --activity                export a compact activity trace too: tool calls, messages, reasoning summaries,",
    "                            token usage, approvals, and errors, in order. Long text is cut.",
    "  --json                    Print JSON or JSON Lines.",
    "  -h, --help                Show this help.",
    "",
  ].join("\n"))
}

function optionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("-")) throw agentDiagnostics.AGENT_R0502({ message: `Missing value for ${flag}.` })
  return value
}

function positiveInteger(value: string, flag: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result <= 0) throw agentDiagnostics.AGENT_R0503({ message: `${flag} requires a positive integer.` })
  return result
}

function duration(value: string, flag: string): number {
  const result = parseRetentionDuration(value)
  if (result === undefined) throw agentDiagnostics.AGENT_R0930({ message: `${flag} requires a duration such as 90m, 12h, or 30d.` })
  return result
}

function size(value: string, flag: string): RetentionSizeLimit {
  // A bare integer is a number of bytes, as in the maxSize option.
  const bytes = /^\d+$/.test(value.trim()) ? Number(value) : undefined
  const result = bytes !== undefined && Number.isSafeInteger(bytes) && bytes >= 1 ? { bytes } : parseRetentionSize(value)
  if (result === undefined) throw agentDiagnostics.AGENT_R0930({ message: `${flag} requires a size such as 500MB or 3GB, a number of bytes, or a percent of the volume such as 30%.` })
  return result
}

/** A positive duration. A bare integer is milliseconds, so `--interval 500` keeps working. */
function milliseconds(value: string, flag: string): number {
  const result = /^\d+$/.test(value.trim()) ? Number(value) : duration(value, flag)
  if (!Number.isSafeInteger(result) || result <= 0) throw agentDiagnostics.AGENT_R0503({ message: `${flag} requires a positive duration such as 500, 5s, or 30m.` })
  return result
}

function formatDuration(value: number): string {
  for (const unit of ["w", "d", "h", "m", "s"]) {
    const size = durationUnits[unit]!
    if (value >= size && value % size === 0) return `${value / size}${unit}`
  }
  return `${value}ms`
}

/** An age such as 7d, or an ISO date such as 2026-10-01. Returns the ISO time it selects. */
function sinceTime(value: string): string {
  const time = /^\d+(?:ms|s|m|h|d|w)$/.test(value.trim())
    ? Date.now() - duration(value, "--since")
    : /^\d{4}-\d{2}-\d{2}/.test(value.trim()) ? Date.parse(value) : Number.NaN
  if (Number.isNaN(time)) throw agentDiagnostics.AGENT_R0503({ message: "--since requires a duration such as 7d or an ISO date such as 2026-10-01." })
  return new Date(time).toISOString()
}

function redactCliArgument(argument: string): string {
  const separator = argument.startsWith("-") ? argument.indexOf("=") : -1
  const prefix = separator === -1 ? "" : argument.slice(0, separator + 1)
  const value = separator === -1 ? argument : argument.slice(separator + 1)
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) return argument
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return `${prefix}${url.href}`
  }
  catch {
    return `${prefix}[redacted]`
  }
}

function parse(args: string[], env: NodeJS.ProcessEnv): ParsedArgs {
  const parsed: ParsedArgs = {
    activity: false,
    dryRun: false,
    help: false,
    interval: 1_000,
    json: false,
    observations: false,
    server: false,
    staleAfter: waitIdleDefaults.staleAfter,
    url: env.VITEHUB_AGENT_INVOCATIONS_URL || "http://localhost:5173/api/invocations",
    urlSet: false,
    waitTimeout: waitIdleDefaults.timeout,
  }
  const target: { timeout?: number, url: string } = { url: parsed.url }
  // --timeout is the request timeout, except for wait-idle, where it is how long to wait.
  const actionOptionsWithValues = new Set(["--agent", "--url", "--database", "--table-prefix", "--older-than", "--max-size", "--max-records", "--status", "--timeout", "--interval", "--stale-after", "--origin", "--since"])
  let actionFromPositionals: Action | "cancel" | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (actionOptionsWithValues.has(argument)) { index += 1; continue }
    if ([...actionOptionsWithValues].some(flag => argument.startsWith(`${flag}=`))) continue
    if (!argument.startsWith("-") && (argument === "cancel" || isAction(argument))) { actionFromPositionals = argument; break }
  }
  const waiting = actionFromPositionals === "wait-idle"
  let intervalSet = false
  let staleAfterSet = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    const used = waiting && (argument === "--timeout" || argument.startsWith("--timeout="))
      ? undefined
      : readViteHubDevTargetOption(args, index, target, devTargetErrors)
    if (waiting && argument === "--timeout") { parsed.waitTimeout = milliseconds(optionValue(args, index, argument), argument); index += 1 }
    else if (waiting && argument.startsWith("--timeout=")) parsed.waitTimeout = milliseconds(argument.slice("--timeout=".length), "--timeout")
    else if (used !== undefined) {
      index += used
      if (argument === "--url" || argument === "--server" || argument.startsWith("--url=")) {
        parsed.urlSet = true
        parsed.server = argument === "--server"
      }
      parsed.url = target.url
      if (target.timeout !== undefined) parsed.timeout = target.timeout
    }
    else if (argument === "-h" || argument === "--help") parsed.help = true
    else if (argument === "--json") parsed.json = true
    else if (argument === "--dry-run") parsed.dryRun = true
    else if (argument === "--observations") parsed.observations = true
    else if (argument === "--activity") parsed.activity = true
    else if (argument === "--origin") { parsed.origin = optionValue(args, index, argument); index += 1 }
    else if (argument.startsWith("--origin=")) parsed.origin = argument.slice("--origin=".length)
    else if (argument === "--agent") { parsed.agent = optionValue(args, index, argument); index += 1 }
    else if (argument.startsWith("--agent=")) parsed.agent = argument.slice("--agent=".length)
    else if (argument === "--since") { parsed.since = sinceTime(optionValue(args, index, argument)); index += 1 }
    else if (argument.startsWith("--since=")) parsed.since = sinceTime(argument.slice("--since=".length))
    else if (argument === "--database") { parsed.database = optionValue(args, index, argument); index += 1 }
    else if (argument.startsWith("--database=")) parsed.database = argument.slice("--database=".length)
    else if (argument === "--table-prefix") { parsed.tablePrefix = optionValue(args, index, argument); index += 1 }
    else if (argument.startsWith("--table-prefix=")) parsed.tablePrefix = argument.slice("--table-prefix=".length)
    else if (argument === "--older-than") { parsed.olderThanMs = duration(optionValue(args, index, argument), argument); index += 1 }
    else if (argument.startsWith("--older-than=")) parsed.olderThanMs = duration(argument.slice("--older-than=".length), "--older-than")
    else if (argument === "--max-size") { parsed.maxSize = size(optionValue(args, index, argument), argument); index += 1 }
    else if (argument.startsWith("--max-size=")) parsed.maxSize = size(argument.slice("--max-size=".length), "--max-size")
    else if (argument === "--max-records") { parsed.maxRecords = positiveInteger(optionValue(args, index, argument), argument); index += 1 }
    else if (argument.startsWith("--max-records=")) parsed.maxRecords = positiveInteger(argument.slice("--max-records=".length), "--max-records")
    else if (argument === "--status") {
      parsed.status = optionValue(args, index, argument)
      index += 1
    }
    else if (argument.startsWith("--status=")) parsed.status = argument.slice(9)
    else if (argument === "--limit") {
      parsed.limit = positiveInteger(optionValue(args, index, argument), argument)
      index += 1
    }
    else if (argument.startsWith("--limit=")) parsed.limit = positiveInteger(argument.slice(8), "--limit")
    else if (argument === "--interval") {
      parsed.interval = milliseconds(optionValue(args, index, argument), argument)
      intervalSet = true
      index += 1
    }
    else if (argument.startsWith("--interval=")) {
      parsed.interval = milliseconds(argument.slice(11), "--interval")
      intervalSet = true
    }
    else if (argument === "--stale-after") { parsed.staleAfter = milliseconds(optionValue(args, index, argument), argument); staleAfterSet = true; index += 1 }
    else if (argument.startsWith("--stale-after=")) { parsed.staleAfter = milliseconds(argument.slice("--stale-after=".length), "--stale-after"); staleAfterSet = true }
    else if (argument.startsWith("-")) throw agentDiagnostics.AGENT_R0504({ message: `Unknown option: ${redactCliArgument(argument)}.` })
    else if (!parsed.action && (argument === "cancel" || isAction(argument))) parsed.action = argument
    else if (!parsed.id && parsed.action && !journalActions.has(parsed.action)) parsed.id = argument
    else throw agentDiagnostics.AGENT_R0505({ message: `Unexpected argument: ${redactCliArgument(argument)}.` })
  }

  if (!parsed.help && !parsed.action) throw agentDiagnostics.AGENT_R0506({ message: "Choose list, show, tail, export, wait-idle, cancel, delete, prune, or compact." })
  if (!parsed.help && !journalActions.has(parsed.action) && !parsed.id) throw agentDiagnostics.AGENT_R0507({ message: `${parsed.action} requires an invocation id.` })
  if (!parsed.help && parsed.dryRun && parsed.action !== "prune" && parsed.action !== "compact") throw agentDiagnostics.AGENT_R0505({ message: "--dry-run is only supported for prune and compact." })
  if (!parsed.help && !waiting && staleAfterSet) throw agentDiagnostics.AGENT_R0505({ message: "--stale-after is only supported for wait-idle." })
  if (!parsed.help && !waiting && parsed.action !== "export" && parsed.agent !== undefined) throw agentDiagnostics.AGENT_R0505({ message: "--agent is only supported for wait-idle and export." })
  if (waiting && !intervalSet) parsed.interval = waitIdleDefaults.interval
  if (!parsed.help && parsed.urlSet && parsed.action === "compact") throw agentDiagnostics.AGENT_R0505({ message: "compact rebuilds a local SQLite file. Pass --database with the file path instead of --url or --server." })
  const exportOnly = [["--origin", parsed.origin], ["--since", parsed.since], ["--observations", parsed.observations || undefined], ["--activity", parsed.activity || undefined]] as const
  const misplaced = exportOnly.find(([, value]) => value !== undefined)?.[0]
  if (!parsed.help && parsed.action !== "export" && misplaced) throw agentDiagnostics.AGENT_R0505({ message: `${misplaced} is only supported for export.` })
  if (parsed.action === "export" && parsed.status !== undefined && !invocationStatuses.has(parsed.status)) {
    throw agentDiagnostics.AGENT_R0503({ message: `--status must be one of ${[...invocationStatuses].join(", ")}.` })
  }
  if (!parsed.help && (parsed.maxSize || parsed.maxRecords !== undefined) && parsed.action !== "prune") {
    throw agentDiagnostics.AGENT_R0505({ message: "--max-size and --max-records are only supported for prune." })
  }
  if (!parsed.help && parsed.urlSet && !parsed.server && parsed.action !== "delete" && parsed.action !== "prune" && parsed.action !== "compact") {
    const app = appUrl(parsed.url)
    if (app) {
      parsed.console = app.base
      parsed.consoleFallback = app.loopback && !app.consolePath
      if (app.consolePath) parsed.deprecated = { form: "is the Console URL", use: `--url ${displayUrl(app.base)}, the app URL` }
    }
    else if (localUrl(parsed.url)) parsed.deprecated = oldLocalForm(parsed)
  }
  if (!parsed.help && parsed.database !== undefined && parsed.action === "cancel") {
    throw agentDiagnostics.AGENT_R0505({ message: "cancel needs the running app. Pass --url or --server instead of --database." })
  }
  const readsFile = parsed.database !== undefined && fileActions.has(parsed.action)
  if (!parsed.help && readsFile && parsed.urlSet) throw agentDiagnostics.AGENT_R0505({ message: "Pass --url or --database, not both." })
  if ((parsed.console || readsFile) && parsed.status !== undefined && !invocationStatuses.has(parsed.status)) {
    throw agentDiagnostics.AGENT_R0503({ message: `--status must be one of ${[...invocationStatuses].join(", ")}.` })
  }
  // cancel targets the Vite Development Server, not the application inspection route.
  if (parsed.action === "cancel" && !parsed.urlSet) parsed.url = resolveViteHubDevServerUrl(env)
  return parsed
}

const invocationStatuses = new Set<string>(["pending", "running", "completed", "failed", "cancelled"])

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]"
}

/**
 * `--url` is the app URL, as in every `vitehub` command, so the command calls the Console RPC under it. A pasted
 * Console URL (a `/_vitehub` path) still works for one minor version. A localhost URL with a query or a fragment can
 * only be an old local endpoint, so it returns undefined.
 */
function appUrl(value: string): { base: URL, consolePath: boolean, loopback: boolean } | undefined {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    return
  }
  const consolePath = /(?:^|\/)_vitehub(?:\/|$)/.exec(url.pathname)
  const loopback = isLoopbackHost(url.hostname)
  if (loopback && !consolePath && (url.username || url.password || url.search || url.hash)) return
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw agentDiagnostics.AGENT_R0503({ message: "--url must use HTTPS for a deployed Console, except for localhost." })
  }
  if (url.username || url.password || url.search || url.hash) {
    throw agentDiagnostics.AGENT_R0503({ message: "--url must not contain credentials, a query, or a fragment. Set VITEHUB_CONSOLE_PRIVATE_KEY_<NAME> to sign the calls." })
  }
  // The RPC endpoint is under the app base.
  const base = consolePath ? url.pathname.slice(0, consolePath.index) : url.pathname
  url.pathname = base.endsWith("/") ? base : `${base}/`
  return { base: url, consolePath: Boolean(consolePath), loopback }
}

function localUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname)
  }
  catch {
    return false
  }
}

/** A URL without credentials, a query, or a fragment, for messages. */
function displayUrl(value: string | URL): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`
  }
  catch {
    return "the URL"
  }
}

/** The old local meaning of a localhost `--url`: the dev server for cancel, a local invocation endpoint otherwise. */
function oldLocalForm(parsed: ParsedArgs): { form: string, use: string } {
  return parsed.action === "cancel"
    ? { form: "has no ViteHub Console, so the command sent the cancel to the Vite Development Server", use: `--server ${new URL(parsed.url).origin} for the Development Server, or the URL of an app with the Console on` }
    : { form: "has no ViteHub Console, so the command read it as a local invocation endpoint", use: "the URL of an app with the Console on, such as --url http://localhost:3000. The command reads its Invocations through the Console" }
}

function writeDeprecation(context: AgentInvocationsCliContext, parsed: ParsedArgs, deprecated: { form: string, use: string }): void {
  context.stderr.write(`${formatRuntimeDiagnosticError(agentDiagnostics.AGENT_R1053({ ...deprecated, url: displayUrl(parsed.url) }))}\n`)
}

function endpoint(parsed: ParsedArgs, id?: string): URL {
  const base = new URL(parsed.url)
  if (id) base.pathname = `${base.pathname.replace(/\/$/, "")}/${encodeURIComponent(id)}`
  if (!id && parsed.status) base.searchParams.set("status", parsed.status)
  if (!id && parsed.limit) base.searchParams.set("limit", String(parsed.limit))
  return base
}

type ResponseParser<T> = (value: unknown) => T

function isInvocationSummary(value: unknown): boolean {
  return isRuntimeRecord(value)
    && typeof value.createdAt === "string"
    && typeof value.cursor === "string"
    && typeof value.id === "string"
    && typeof value.status === "string"
    && typeof value.traceId === "string"
    && typeof value.updatedAt === "string"
    && (value.error === undefined || isRuntimeRecord(value.error))
}

function parseInvocationList(value: unknown): AgentInvocationListResult {
  if (!isRuntimeRecord(value) || !Array.isArray(value.invocations) || value.invocations.some(record => !isInvocationSummary(record)) || value.cursor !== undefined && typeof value.cursor !== "string") {
    throw agentDiagnostics.AGENT_R0508({ message: "Invocation inspection returned an invalid list response." })
  }
  // SAFETY: The list parser validates its cursor and every summary field consumed by the CLI.
  return asUnknownBoundary(value) as AgentInvocationListResult
}

function parseInvocationDetail(value: unknown): AgentInvocationDetailResult {
  if (!isRuntimeRecord(value) || !isInvocationSummary(value.invocation) || !Array.isArray(value.observations)
    || (value.observationCursor !== undefined && typeof value.observationCursor !== "string")
    || (value.appendObservations !== undefined && typeof value.appendObservations !== "boolean")) {
    throw agentDiagnostics.AGENT_R0509({ message: "Invocation inspection returned an invalid detail response." })
  }
  for (const observation of value.observations) {
    if (!isRuntimeRecord(observation) || typeof observation.name !== "string" || typeof observation.sequence !== "number" || typeof observation.timestamp !== "string") {
      throw agentDiagnostics.AGENT_R0510({ message: "Invocation inspection returned an invalid observation." })
    }
  }
  // SAFETY: The detail parser validates the invocation summary and each observation field consumed by the CLI.
  return asUnknownBoundary(value) as AgentInvocationDetailResult
}

/** Console RPC contract owned by `vite-hub/console`. Its tests drive this client against the real handler. */
/** The Console returns at most 100 records per page. */
const consolePageLimit = 100
const consoleDefaultListLimit = 50

interface ConsoleTarget {
  base: URL
  env: NodeJS.ProcessEnv
  fetch: typeof fetch
  timeout: number
}

function hasConsoleCredentials(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some(name => name.startsWith("VITEHUB_CONSOLE_PRIVATE_KEY_") && Boolean(env[name]))
}

/** Send one Console RPC call. A failure becomes an error with the HTTP status and the Console message. */
async function consoleCall<T>(target: ConsoleTarget, operation: string, input: Record<string, unknown>, parseResponse: ResponseParser<T>): Promise<T> {
  const url = new URL(operationRpcPath.slice(1), target.base)
  let outcome: OperationRpcOutcome<{ body: unknown, response: Response }>
  try {
    outcome = await callOperationRpc(operation, input, async (body) => {
      const response = await target.fetch(url.href, {
        body,
        headers: await signedOperationHeaders(target.env, url, body),
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(target.timeout),
      })
      const text = await response.text()
      let json: unknown
      try {
        json = text ? JSON.parse(text) : undefined
      }
      catch {
        json = undefined
      }
      return { body: json, response }
    })
  }
  catch (error) {
    throw agentDiagnostics.AGENT_R0511({ message: `Console request to ${url.origin} failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (outcome.ok) return parseResponse(outcome.value)
  const { body: json, response } = outcome.answer
  // Host middleware, such as the Console sign-in check, answers with the diagnostic body and no birpc reply.
  const failure: unknown = outcome.error ?? json
  const answered = outcome.error !== undefined || (isRuntimeRecord(json) && json.ok === false)
  const message = isRuntimeRecord(failure) && typeof failure.message === "string" && failure.message ? failure.message.replace(/\.$/, "") : undefined
  const status = outcome.error?.status ?? (response.ok && isRuntimeRecord(json) && typeof json.status === "number" ? json.status : response.status)
  if (status === 401 || (status >= 300 && status < 400)) {
    throw agentDiagnostics.AGENT_R0511({ message: `Console authentication failed with HTTP ${status}${message ? `: ${message}` : ""}. ${operationCredentialHint}` })
  }
  if (status === 403) {
    throw agentDiagnostics.AGENT_R0511({ message: `Console denied the request with HTTP 403${message ? `: ${message}` : ""}.${hasConsoleCredentials(target.env) ? "" : ` ${operationCredentialHint}`}` })
  }
  // A page, another JSON endpoint, or a missing route, not a Console reply. On localhost the old local meaning can run instead.
  if (!answered && (!isRuntimeRecord(json) || status < 300 || status === 404 || status === 405)) {
    const error = agentDiagnostics.AGENT_R0511({ message: `${url.origin}${target.base.pathname} did not answer as a ViteHub Console (HTTP ${status}). Pass the app URL of a deployment that enables the Console.` })
    notConsoleAnswers.add(error)
    throw error
  }
  throw agentDiagnostics.AGENT_R0511({ message: `Console request failed with HTTP ${status}${message ? `: ${message}` : ""}.` })
}

type InvocationSummary = AgentInvocationListResult["invocations"][number]

/** Errors of a URL where no ViteHub Console answered. */
const notConsoleAnswers = new WeakSet<Error>()

/**
 * A localhost app URL: its Console. When no Console answers, the old local meaning runs once for the whole command,
 * after AGENT_R1053, for one minor version.
 */
function appInvocationsTarget(consoleTarget: InvocationsTarget, local: () => InvocationsTarget, deprecate: () => void): InvocationsTarget {
  let chosen: InvocationsTarget | undefined
  async function use<T>(call: (target: InvocationsTarget) => Promise<T>): Promise<T> {
    if (chosen) return await call(chosen)
    try {
      const value = await call(consoleTarget)
      chosen = consoleTarget
      return value
    }
    catch (error) {
      if (!(error instanceof Error) || !notConsoleAnswers.has(error)) throw error
      deprecate()
      chosen = local()
      return await call(chosen)
    }
  }
  return {
    cancel: async id => await use(target => target.cancel(id)),
    detail: async (id, observations) => await use(target => target.detail(id, observations)),
    list: async () => await use(target => target.list()),
    scan: async (statuses, timeout) => await use(target => target.scan(statuses, timeout)),
  }
}

/** Follow list cursors until `wanted` records pass `keep` or the pages end. A repeated cursor ends the read. */
async function collectPages(
  readPage: (cursor: string | undefined, collected: number) => Promise<AgentInvocationListResult>,
  keep: (record: InvocationSummary) => boolean,
  wanted = Number.POSITIVE_INFINITY,
): Promise<InvocationSummary[]> {
  const invocations: InvocationSummary[] = []
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await readPage(cursor, invocations.length)
    for (const record of page.invocations) {
      if (ids.has(record.id) || !keep(record)) continue
      ids.add(record.id)
      invocations.push(record)
    }
    cursor = page.cursor
    if (cursor !== undefined && cursors.has(cursor)) break
    if (cursor !== undefined) cursors.add(cursor)
  } while (cursor !== undefined && invocations.length < wanted)
  return invocations.slice(0, wanted)
}

/** List through the Console. The Console has no status filter, so the CLI filters and follows cursors until it has enough records. */
async function listConsoleInvocations(target: ConsoleTarget, wanted: number, statuses?: ReadonlySet<string>): Promise<InvocationSummary[]> {
  return await collectPages(async (cursor, collected) => {
    const input: Record<string, unknown> = { limit: Math.min(consolePageLimit, statuses ? consolePageLimit : wanted - collected) }
    if (cursor !== undefined) input.cursor = cursor
    return await consoleCall(target, invocationOperationNames.list, input, parseInvocationList)
  }, record => !statuses || statuses.has(record.status), wanted)
}

interface InvocationsTarget {
  cancel: (id: string) => Promise<AgentInvocationCancelResult | undefined>
  /** Read one record. Pass the previous count and cursor to receive only new observations when the server supports it. */
  detail: (id: string, observations?: { count: number, cursor: string }) => Promise<AgentInvocationDetailResult>
  list: () => Promise<AgentInvocationListResult>
  /** Every record with one of these statuses, following list cursors to the end. */
  scan: (statuses: readonly string[], timeout?: number) => Promise<InvocationSummary[]>
}

function consoleInvocationsTarget(target: ConsoleTarget, parsed: ParsedArgs): InvocationsTarget {
  return {
    cancel: async id => await consoleCall(target, invocationOperationNames.cancel, { id }, parseCancelResult),
    detail: async (id, observations) => await consoleCall(target, invocationOperationNames.get, {
      id,
      ...(observations === undefined ? {} : { observationCount: observations.count, observationCursor: observations.cursor }),
    }, parseInvocationDetail),
    list: async () => ({
      invocations: await listConsoleInvocations(target, parsed.limit ?? consoleDefaultListLimit, parsed.status ? new Set([parsed.status]) : undefined),
    }),
    // One pass over the Console pages serves every status.
    scan: async (statuses, timeout) => {
      const requestTarget = timeout === undefined ? target : { ...target, timeout }
      return await listConsoleInvocations(requestTarget, Number.POSITIVE_INFINITY, new Set(statuses))
    },
  }
}

/** Read a journal file through the same response parsers as an endpoint, so every target prints the same records. */
async function journalFileTarget(parsed: ParsedArgs, context: AgentInvocationsCliContext): Promise<InvocationsTarget & { close: () => void }> {
  const database = journalDatabase(parsed, context)
  if (database.path === undefined) {
    throw agentDiagnostics.AGENT_R0931({ message: "--database for list, show, tail, export, and wait-idle reads a local SQLite file. Use --url for a deployed app." })
  }
  if (!existsSync(database.path)) throw agentDiagnostics.AGENT_R0931({ message: `No Agent Invocation journal exists at ${database.label}.` })
  const file = await openAgentInvocationJournalFile(database.path, parsed.tablePrefix)
  return {
    cancel: async () => {
      throw agentDiagnostics.AGENT_R0505({ message: "cancel needs the running app. Pass --url or --server instead of --database." })
    },
    close: file.close,
    detail: async (id) => {
      const detail = file.get(id)
      if (!detail) throw agentDiagnostics.AGENT_R0931({ message: `Agent Invocation ${id} was not found in ${database.label}.` })
      return parseInvocationDetail(detail)
    },
    list: async () => parseInvocationList(file.list({ limit: Math.min(parsed.limit ?? consoleDefaultListLimit, maxAgentInvocationListLimit), ...(parsed.status === undefined ? {} : { status: parsed.status }) })),
    scan: async statuses => {
      const records = new Map<string, InvocationSummary>()
      for (const status of statuses) {
        let cursor: string | undefined
        do {
          const page = parseInvocationList(file.list({ cursor, limit: maxAgentInvocationListLimit, status }))
          for (const record of page.invocations) records.set(record.id, record)
          cursor = page.cursor
        } while (cursor !== undefined)
      }
      return [...records.values()]
    },
  }
}

function localInvocationsTarget(parsed: ParsedArgs, context: AgentInvocationsCliContext, fetchImpl: typeof fetch, timeout: number): InvocationsTarget {
  return {
    cancel: async id => await requestCancel(parsed, id, context, fetchImpl, timeout),
    detail: async (id, observations) => {
      const url = endpoint(parsed, id)
      if (observations) {
        url.searchParams.set("observationCount", String(observations.count))
        url.searchParams.set("observationCursor", observations.cursor)
      }
      return await request(url, fetchImpl, timeout, parseInvocationDetail)
    },
    list: async () => await request(endpoint(parsed), fetchImpl, timeout, parseInvocationList),
    scan: async (statuses, scanTimeout) => {
      const requestedStatuses = new Set(statuses)
      const page = async (cursor: string | undefined) => {
        const url = new URL(parsed.url)
        url.searchParams.delete("status")
        for (const status of statuses) url.searchParams.append("status", status)
        if (cursor !== undefined) url.searchParams.set("cursor", cursor)
        return await request(url, fetchImpl, scanTimeout ?? timeout, parseInvocationList)
      }
      return await collectPages(page, record => requestedStatuses.has(record.status))
    },
  }
}

async function request<T>(url: URL, fetchImpl: typeof fetch, timeout: number, parseResponse: ResponseParser<T>): Promise<T> {
  const response = await fetchImpl(url.href, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw agentDiagnostics.AGENT_R0511({ message: (await response.text()).trim() || `Invocation inspection failed with status ${response.status}.` })
  const value: unknown = await response.json()
  return parseResponse(value)
}

const cancelOutcomes = new Set<unknown>(["not-found", "requested", "terminal", "unavailable"])

function parseCancelResult(value: unknown): AgentInvocationCancelResult {
  if (
    !isRuntimeRecord(value)
    || typeof value.id !== "string"
    || !cancelOutcomes.has(value.outcome)
    || (value.status !== undefined && typeof value.status !== "string")
    || (value.notEnforcedBy !== undefined && typeof value.notEnforcedBy !== "string")
    || (value.delivery !== undefined && value.delivery !== "journal" && value.delivery !== "local")
  ) {
    throw agentDiagnostics.AGENT_R0971({ message: "Invocation cancel returned an invalid response." })
  }
  // SAFETY: The parser validates every cancel result field consumed by the CLI.
  return asUnknownBoundary(value) as AgentInvocationCancelResult
}

async function requestCancel(parsed: ParsedArgs, id: string, context: AgentInvocationsCliContext, fetchImpl: typeof fetch, timeout: number): Promise<AgentInvocationCancelResult | undefined> {
  const rootDir = context.rootDir ?? process.cwd()
  const discoveryOptions = {
    parseDiscovery: parseCancelDiscovery,
    endpoint: cancelEndpoint,
    fetch: (input: string | URL | Request, init?: RequestInit) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeout) }),
    isCompatibleRoot: isCompatibleAgentDevServerRoot,
    rootDir,
    serverUrl: parsed.url,
    stderr: context.stderr,
  }
  const server = await discoverViteHubDevServer<AgentInvocationsDevDiscovery>(discoveryOptions)
  if (!server) return
  const { url } = server
  const discovery = parseCancelDiscovery(server.discovery)
  // Nuxt and plain Vite do not run Nitro in the Vite process, so the cancel cannot reach the application runtime.
  if (discovery.runtime !== "nitro") {
    context.stderr.write(`${typeof discovery.message === "string" ? discovery.message : agentInvocationsDevRuntimeUnavailableMessage}\n`)
    return
  }
  const body: AgentInvocationsDevRequestBody = { id, operation: "cancel" }
  if (typeof discovery.workspaceDevTokenServerId !== "string") {
    throw agentDiagnostics.AGENT_R0971({ message: "Invocation cancellation discovery did not publish a token server ID." })
  }
  const token = await readWorkspaceDevToken(typeof discovery.root === "string" ? discovery.root : rootDir, { serverId: discovery.workspaceDevTokenServerId })
  if (!token) throw agentDiagnostics.AGENT_R0972({ message: "No private Agent Dev token found. Start the Compatible Vite Development Server first." })
  const response = await fetchViteHubDevEndpoint(fetchImpl, url, cancelEndpoint, {
    body: JSON.stringify(body),
    headers: { "accept": "application/json", "content-type": "application/json", [workspaceDevTokenHeader]: token, [agentInvocationsDevTokenServerHeader]: discovery.workspaceDevTokenServerId },
    method: "POST",
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw agentDiagnostics.AGENT_R0972({ message: await cancelFailureMessage(response) })
  return parseCancelResult(await response.json())
}

async function cancelFailureMessage(response: Response): Promise<string> {
  const text = (await response.text()).trim()
  try {
    const value: unknown = JSON.parse(text)
    const message: unknown = isRuntimeRecord(value) && isRuntimeRecord(value.error) ? value.error.message : undefined
    if (typeof message === "string" && message) return message
  }
  catch {
    // Plain text responses carry the message as the body.
  }
  return text || `Invocation cancel failed with status ${response.status}.`
}

function cancelMessage(result: AgentInvocationCancelResult): string {
  if (result.outcome === "not-found") return `${result.id} not found`
  if (result.outcome === "terminal") return result.notEnforcedBy
    ? `${result.id} journal is ${result.status ?? "terminal"}; local abort requested, not enforced by ${result.notEnforcedBy}`
    : `${result.id} already ${result.status ?? "finished"}`
  if (result.outcome === "unavailable") return `${result.id} cancel request was not recorded`
  if (result.notEnforcedBy) return `${result.id} cancel requested, not enforced by ${result.notEnforcedBy}`
  if (result.delivery === "journal") return `${result.id} cancel request recorded; execution stop is unconfirmed`
  return `${result.id} cancel requested`
}

function cancelExitCode(result: AgentInvocationCancelResult): number {
  if (result.outcome === "requested") return 0
  return result.outcome === "terminal" && result.status === "cancelled" && !result.notEnforcedBy ? 0 : 1
}

function formatError(error: RuntimeDiagnosticError, indent = ""): string {
  const lines = [`${indent}${error.name || "Error"}: ${error.message}`]
  if (error.cause) lines.push(formatError(error.cause, `${indent}  caused by `))
  for (const nested of error.errors || []) lines.push(formatError(nested, `${indent}  `))
  return lines.join("\n")
}

function summary(record: AgentInvocationRecord | AgentInvocationListResult["invocations"][number]): string {
  const error = record.error ? ` ${formatError(record.error)}` : ""
  return `${record.id} ${record.status} ${record.updatedAt}${error}`
}

function writeRecord(context: AgentInvocationsCliContext, record: AgentInvocationRecord, json: boolean): void {
  if (json) context.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
  else {
    context.stdout.write(`${summary(record)}\n`)
    for (const observation of record.observations) {
      context.stdout.write(`  ${observation.sequence} ${observation.timestamp} ${observation.name}\n`)
    }
  }
}

interface JournalDatabase {
  authToken?: string
  /** Location without credentials, query, or fragment. Safe to print. */
  label: string
  path?: string
  /** Credentials from the URL and environment. Removed from every printed error. */
  secrets: string[]
  url: string
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

function journalDatabase(parsed: ParsedArgs, context: AgentInvocationsCliContext): JournalDatabase {
  const root = resolveViteHubProjectRoot(context.rootDir ?? process.cwd())
  const configured = parsed.database?.trim() || context.env[defaultAgentInvocationsUrlEnv]?.trim()
  const authToken = configured ? context.env[defaultAgentInvocationsAuthTokenEnv] : undefined
  const token = authToken ? { authToken } : {}
  const secrets = authToken ? [authToken] : []
  const isWindowsPath = /^[a-z]:[\\/]/i.test(configured ?? "")
  if (configured && !isWindowsPath && !/^file:/i.test(configured) && /^[a-z][a-z\d+.-]+:/i.test(configured)) {
    let location: URL
    try {
      location = new URL(configured)
    }
    catch {
      throw agentDiagnostics.AGENT_R0931({ message: "The Agent Invocation journal database URL is invalid." })
    }
    for (const value of [location.username, location.password]) {
      if (value) secrets.push(value, safeDecode(value))
    }
    for (const value of location.searchParams.values()) {
      if (value) secrets.push(value, encodeURIComponent(value))
    }
    return { ...token, label: `${location.protocol}//${location.host}${location.pathname === "/" ? "" : location.pathname}`, secrets, url: configured }
  }
  const target = configured || resolve(root, defaultAgentInvocationsPath)
  const withoutFragment = target.split("#", 1)[0]!
  const queryIndex = withoutFragment.indexOf("?")
  const location = queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex)
  const query = queryIndex === -1 ? "" : withoutFragment.slice(queryIndex)
  const path = /^file:\//i.test(location)
    ? fileURLToPath(location)
    : resolve(root, /^file:/i.test(location) ? decodeURIComponent(location.slice(5)) : location)
  for (const value of new URLSearchParams(query).values()) {
    if (value) secrets.push(value)
  }
  return { ...token, label: path, path, secrets, url: `${pathToFileURL(path).href}${query}` }
}

async function withJournalStore<T>(parsed: ParsedArgs, context: AgentInvocationsCliContext, use: (store: AgentInvocationStore) => Promise<T>, retention: AgentRetentionPolicy = {}): Promise<T> {
  const database = journalDatabase(parsed, context)
  if (database.path !== undefined && !existsSync(database.path)) {
    throw agentDiagnostics.AGENT_R0931({ message: `No Agent Invocation journal exists at ${database.label}. Pass --database with the journal URL.` })
  }
  const [{ createClient }, { createLibsqlAgentInvocationStore }] = await Promise.all([
    import("@libsql/client"),
    import("../invocations/sqlite.ts"),
  ])
  let client: ReturnType<typeof createClient>
  try {
    client = createClient({ ...(database.authToken ? { authToken: database.authToken } : {}), url: database.url })
  }
  catch (error) {
    throw redactedJournalError(error, database)
  }
  try {
    const table = `${parsed.tablePrefix ?? "vitehub_agent_"}invocations`
    const store = createLibsqlAgentInvocationStore({ client, maxAge: false, maxRecords: false, ...retention, ...(parsed.tablePrefix === undefined ? {} : { tablePrefix: parsed.tablePrefix }) })
    const existing = await client.execute({ args: [table], sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?" })
    if (!existing.rows.length) {
      throw agentDiagnostics.AGENT_R0931({ message: `No Agent Invocation journal table ${table} exists in ${database.label}.` })
    }
    return await use(store)
  }
  catch (error) {
    throw redactedJournalError(error, database)
  }
  finally {
    client.close()
  }
}

// Database clients can echo the connection URL or token. Print only the redacted location.
function redactedJournalError(error: unknown, database: JournalDatabase): unknown {
  if (!(error instanceof Error)) return error
  let message = error.message.split(database.url).join(database.label)
  for (const secret of database.secrets) message = message.split(secret).join("[redacted]")
  if (message === error.message) return error
  return agentDiagnostics.AGENT_R0931({ message })
}

async function deleteInvocation(parsed: ParsedArgs, context: AgentInvocationsCliContext, id: string): Promise<number> {
  const outcome = await withJournalStore(parsed, context, async store => await store.delete!(id))
  if (parsed.json) context.stdout.write(`${JSON.stringify({ id, outcome })}\n`)
  else if (outcome === "deleted") context.stdout.write(`Deleted ${id}.\n`)
  if (outcome === "deleted") return 0
  if (!parsed.json) {
    context.stderr.write(outcome === "not-found"
      ? `Agent Invocation ${id} was not found.\n`
      : `Agent Invocation ${id} is pending or running. Wait until it completes, fails, or is cancelled.\n`)
  }
  return 1
}

async function pruneInvocations(parsed: ParsedArgs, context: AgentInvocationsCliContext): Promise<number> {
  if (parsed.maxSize || parsed.maxRecords !== undefined) return await pruneByLimits(parsed, context)
  const olderThanMs = parsed.olderThanMs ?? defaultPruneAgeMs
  const cutoff = new Date(Date.now() - olderThanMs)
  if (Number.isNaN(cutoff.getTime())) {
    throw agentDiagnostics.AGENT_R0930({ message: "--older-than must produce a cutoff within JavaScript's Date range." })
  }
  const updatedBefore = cutoff.toISOString()
  const result = await withJournalStore(parsed, context, async store => await store.prune!({ ...(parsed.dryRun ? { dryRun: true } : {}), updatedBefore }))
  if (parsed.json) {
    context.stdout.write(`${JSON.stringify({ dryRun: result.dryRun, ids: result.ids, olderThanMs, updatedBefore }, null, 2)}\n`)
    return 0
  }
  for (const id of result.ids) context.stdout.write(`${id}\n`)
  const count = `${result.ids.length} terminal Agent Invocation${result.ids.length === 1 ? "" : "s"}`
  context.stdout.write(`${result.dryRun ? "Would delete" : "Deleted"} ${count} last updated before ${updatedBefore}.\n`)
  return 0
}

function activeLine(record: InvocationSummary): string {
  return `${record.id} ${record.status} ${record.agentName || "-"} ${record.updatedAt}`
}

/**
 * Poll until no Invocation is pending or running. Records not updated for --stale-after are reported once and
 * do not block, because a crashed owner can leave a record running. A failed read after the first one is retried.
 */
async function waitIdle(parsed: ParsedArgs, context: AgentInvocationsCliContext, target: InvocationsTarget, sleep: (milliseconds: number) => Promise<void>): Promise<number> {
  const deadline = Date.now() + parsed.waitTimeout
  const printed = { active: "", stale: "" }
  let read = false
  for (;;) {
    let records: InvocationSummary[] | undefined
    try {
      const remaining = Math.max(1, deadline - Date.now())
      records = (await target.scan(activeStatuses, Math.min(parsed.timeout ?? 30_000, remaining))).filter(record => parsed.agent === undefined || record.agentName === parsed.agent)
      read = true
    }
    catch (error) {
      if (!read) throw error
      context.stderr.write(`Read failed, retrying: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    if (records) {
      const staleBefore = Date.now() - parsed.staleAfter
      const stale = records.filter(record => Date.parse(record.updatedAt) < staleBefore)
      const active = records.filter(record => !stale.includes(record))
      const staleKey = stale.map(record => record.id).join(" ")
      if (staleKey !== printed.stale) {
        printed.stale = staleKey
        if (stale.length) context.stderr.write(`Ignoring ${stale.length} stale Agent Invocation(s) not updated for ${formatDuration(parsed.staleAfter)}:\n${stale.map(record => `  ${activeLine(record)}\n`).join("")}`)
      }
      if (Date.now() >= deadline) {
        if (parsed.json) context.stdout.write(`${JSON.stringify({ active, event: "invocations.timeout" })}\n`)
        if (active.length) context.stderr.write(`Still ${active.length} active Agent Invocation(s) after ${formatDuration(parsed.waitTimeout)}:\n${active.map(record => `  ${activeLine(record)}\n`).join("")}`)
        else context.stderr.write(`Could not confirm that no Agent Invocation is active within ${formatDuration(parsed.waitTimeout)}.\n`)
        return 1
      }
      if (!active.length) {
        context.stdout.write(parsed.json
          ? `${JSON.stringify({ event: "invocations.idle", stale })}\n`
          : `Idle: ${stale.length ? `only ${stale.length} stale Agent Invocation(s) remain pending or running` : "no pending or running Agent Invocations"}.\n`)
        return 0
      }
      // Print when the set of active records or their status changes, not on every poll.
      const activeKey = active.map(record => `${record.id}:${record.status}`).join(" ")
      if (activeKey !== printed.active) {
        printed.active = activeKey
        context.stdout.write(parsed.json
          ? `${JSON.stringify({ active, event: "invocations.waiting" })}\n`
          : `Waiting for ${active.length} active Agent Invocation(s):\n${active.map(record => `  ${activeLine(record)}\n`).join("")}`)
      }
    }
    else if (Date.now() >= deadline) {
      context.stderr.write(`Could not confirm that no Agent Invocation is active within ${formatDuration(parsed.waitTimeout)}.\n`)
      return 1
    }
    await sleep(Math.max(0, Math.min(parsed.interval, deadline - Date.now())))
  }
}


type Observation = AgentInvocationRecord["observations"][number]

function observationAttributes(observations: readonly Observation[], name: string): Record<string, unknown>[] {
  return observations.flatMap(observation => observation.name === name ? [observation.attributes ?? {}] : [])
}

/**
 * One export line: the record without observations, plus the prompt, the final assistant text, and each Channel
 * delivery that the observations carry. `final` is the finish result text, or the final message deltas before finish.
 * `--activity` adds the compact activity trace, and `--observations` every observation.
 */
function exportLine(record: AgentInvocationRecord, options: { activity: boolean, observations: boolean }) {
  const { cursor: _cursor, observations, ...invocation } = record
  const start = observationAttributes(observations, "agent.invocation.start")[0] ?? {}
  const finish = observationAttributes(observations, "agent.invocation.finish").at(-1)?.["result.text"]
  const finalDeltaGroups = new Map<string, { sequence: number, text: string }>()
  observations.forEach((observation, index) => {
    if (observation.name !== "agent.message.delta") return
    const delta = observation.attributes ?? {}
    if (delta["message.phase"] !== "final" && delta["message.phase"] !== "final_answer") return
    const id = typeof delta["message.id"] === "string" ? delta["message.id"] : "__anonymous"
    const group = finalDeltaGroups.get(id) ?? { sequence: index, text: "" }
    group.sequence = index
    if (typeof delta["message.content"] === "string") group.text += delta["message.content"]
    finalDeltaGroups.set(id, group)
  })
  const deltas = [...finalDeltaGroups.values()].sort((left, right) => right.sequence - left.sequence)[0]?.text
  return {
    ...invocation,
    runId: start["agent.run.id"],
    prompt: start["input.prompt"],
    final: typeof finish === "string" ? finish : deltas || undefined,
    deliveries: observationAttributes(observations, "agent.channel.delivery.effect").map(effect => ({
      channel: typeof effect["channel.effect.channel"] === "string" ? effect["channel.effect.channel"] : "unknown",
      content: effect["channel.effect.content"],
      intent: effect["channel.effect.intent"],
      kind: effect["channel.effect.kind"],
      ...(effect["channel.effect.skipped"] === undefined ? {} : { skipped: effect["channel.effect.skipped"] }),
    })),
    ...(options.activity ? invocationActivityTrace(observations) : {}),
    ...(options.observations ? { observations } : {}),
  }
}

/** Print the matching Invocations as JSON Lines, oldest first. Filters run on the summaries before any record is read. */
async function exportInvocations(parsed: ParsedArgs, context: AgentInvocationsCliContext, target: InvocationsTarget): Promise<number> {
  const records = (await target.scan(parsed.status ? [parsed.status] : [...invocationStatuses]))
    .filter(record => (parsed.origin === undefined || record.origin === parsed.origin)
      && (parsed.agent === undefined || record.agentName === parsed.agent)
      && (parsed.since === undefined || record.createdAt >= parsed.since))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  for (const summary of records) {
    context.stdout.write(`${JSON.stringify(exportLine(detailRecord(await target.detail(summary.id)), parsed))}\n`)
  }
  return 0
}

/** Applies --max-size and --max-records, and --older-than when it is given, with the store's own retention. */
async function pruneByLimits(parsed: ParsedArgs, context: AgentInvocationsCliContext): Promise<number> {
  const retention: AgentRetentionPolicy = {
    maxAge: parsed.olderThanMs ?? false,
    maxRecords: parsed.maxRecords ?? false,
    maxSize: !parsed.maxSize ? false : "bytes" in parsed.maxSize ? parsed.maxSize.bytes : `${formatRetentionPercentage(parsed.maxSize.fraction)}%`,
  }
  const result = await withJournalStore(parsed, context, async store => await store.prune!(parsed.dryRun ? { dryRun: true } : {}), retention)
  if (parsed.json) {
    context.stdout.write(`${JSON.stringify({ dryRun: result.dryRun, ids: result.ids, limits: retention, ...(result.size ? { size: result.size } : {}) }, null, 2)}\n`)
    return 0
  }
  for (const id of result.ids) context.stdout.write(`${id}\n`)
  const count = `${result.ids.length} terminal Agent Invocation${result.ids.length === 1 ? "" : "s"}`
  context.stdout.write(`${result.dryRun ? "Would delete" : "Deleted"} ${count}.\n`)
  if (result.size) {
    const { afterBytes, beforeBytes, budgetBytes } = result.size
    context.stdout.write(`Live data: ${formatBytes(beforeBytes)} before, ${formatBytes(afterBytes)} after, budget ${formatBytes(budgetBytes)}.\n`)
    if (afterBytes > budgetBytes) context.stdout.write("The journal is still above the budget. Only pending and running records remain.\n")
  }
  return 0
}


const defaultCompactBusyTimeoutMs = 5_000

/** Rebuilds a local SQLite journal file with VACUUM. Remote and in-memory databases have no file to compact. */
async function compactInvocations(parsed: ParsedArgs, context: AgentInvocationsCliContext, options: AgentInvocationsCliOptions): Promise<number> {
  const database = journalDatabase(parsed, context)
  if (database.path === undefined) {
    throw agentDiagnostics.AGENT_R0931({ message: `compact rebuilds a local SQLite file. ${database.label} is a remote libSQL database, which manages its own storage. Pass --database with a local file path.` })
  }
  if (basename(database.path) === ":memory:" || /[?&]mode=memory(?:&|$)/i.test(database.url)) {
    throw agentDiagnostics.AGENT_R0931({ message: "compact rebuilds a local SQLite file. An in-memory database has no file to compact. Pass --database with a local file path." })
  }
  if (!existsSync(database.path)) {
    throw agentDiagnostics.AGENT_R0931({ message: `No Agent Invocation journal exists at ${database.label}. Pass --database with the journal file.` })
  }
  const { createClient } = await import("@libsql/client")
  const client = createClient({ url: database.url })
  let result: JournalCompactResult
  try {
    const table = `${parsed.tablePrefix ?? "vitehub_agent_"}invocations`
    const existing = await client.execute({ args: [table], sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?" })
    if (!existing.rows.length) {
      throw agentDiagnostics.AGENT_R0931({ message: `No Agent Invocation journal table ${table} exists in ${database.label}.` })
    }
    result = await compactJournalFile({
      busyTimeoutMs: options.compactBusyTimeoutMs ?? defaultCompactBusyTimeoutMs,
      client,
      dryRun: parsed.dryRun,
      ...(options.freeSpace ? { freeSpace: options.freeSpace } : {}),
      label: database.label,
      path: database.path,
    })
  }
  catch (error) {
    throw redactedJournalError(error, database)
  }
  finally {
    client.close()
  }
  if (parsed.json) context.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else writeCompactResult(context, result)
  return result.space.ok ? 0 : 1
}

function describeMeasurement(measurement: JournalFileMeasurement): string {
  return `${formatBytes(measurement.fileBytes)} file, ${formatBytes(measurement.walBytes)} WAL, ${measurement.pageCount} pages of ${measurement.pageSize} B, ${measurement.freelistCount} free, auto_vacuum ${measurement.autoVacuum}.`
}

function writeCompactResult(context: AgentInvocationsCliContext, result: JournalCompactResult): void {
  context.stdout.write(`Database: ${result.database}\n`)
  context.stdout.write(`Before: ${describeMeasurement(result.before)}\n`)
  context.stdout.write(`Live data: ${formatBytes(result.before.liveBytes)}. VACUUM shrinks the file to about this size.\n`)
  for (const volume of result.space.volumes) {
    const status = volume.availableBytes >= volume.requiredBytes ? "enough" : "not enough"
    context.stdout.write(`Free space in ${volume.directory} (${volume.uses.join(" and ")}): ${formatBytes(volume.availableBytes)} available, ${formatBytes(volume.requiredBytes)} required, ${status}.\n`)
  }
  if (!result.after) {
    context.stdout.write(result.space.ok ? "Dry run: compact can run. Nothing changed.\n" : "Dry run: compact would refuse to run. Nothing changed.\n")
    return
  }
  context.stdout.write(`After: ${describeMeasurement(result.after)}\n`)
  context.stdout.write(`Reclaimed ${formatBytes(Math.max(0, result.reclaimedBytes ?? 0))}. auto_vacuum is now ${result.after.autoVacuum}.\n`)
  if (result.walTruncated === false) context.stdout.write("A reader kept the WAL from truncating. SQLite reuses the WAL from its start after the reader finishes.\n")
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

function detailRecord(result: AgentInvocationDetailResult): AgentInvocationRecord {
  return { ...result.invocation, observations: result.observations }
}

export async function runAgentInvocationsCli(
  args: string[],
  context: AgentInvocationsCliContext,
  options: AgentInvocationsCliOptions = {},
): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parse(args, context.env)
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    usage(context)
    return 1
  }
  if (parsed.help) {
    usage(context)
    return 0
  }
  const fetchImpl = options.fetch || globalThis.fetch
  const timeout = parsed.timeout ?? options.timeout ?? 30_000
  const sleep = options.sleep || (async (milliseconds: number) => await new Promise<void>(resolve => setTimeout(resolve, milliseconds)))
  let file: Awaited<ReturnType<typeof journalFileTarget>> | undefined
  try {
    if (parsed.deprecated) writeDeprecation(context, parsed, parsed.deprecated)
    const local = () => localInvocationsTarget(parsed, context, fetchImpl, timeout)
    const consoleTarget = parsed.console ? consoleInvocationsTarget({ base: parsed.console, env: context.env, fetch: fetchImpl, timeout }, parsed) : undefined
    const target = parsed.database !== undefined && fileActions.has(parsed.action)
      ? file = await journalFileTarget(parsed, context)
      : consoleTarget && parsed.consoleFallback
        ? appInvocationsTarget(consoleTarget, local, () => writeDeprecation(context, parsed, oldLocalForm(parsed)))
        : consoleTarget ?? local()
    if (parsed.action === "cancel") {
      const result = await target.cancel(parsed.id!)
      if (!result) return 1
      context.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${cancelMessage(result)}\n`)
      return cancelExitCode(result)
    }
    if (parsed.action === "delete") return await deleteInvocation(parsed, context, parsed.id!)
    if (parsed.action === "prune") return await pruneInvocations(parsed, context)
    if (parsed.action === "compact") return await compactInvocations(parsed, context, options)
    if (parsed.action === "wait-idle") return await waitIdle(parsed, context, target, sleep)
    if (parsed.action === "export") return await exportInvocations(parsed, context, target)
    if (parsed.action === "list") {
      const result = await target.list()
      if (parsed.json) context.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      else for (const record of result.invocations) context.stdout.write(`${summary(record)}\n`)
      return 0
    }
    if (parsed.action === "show") {
      writeRecord(context, detailRecord(await target.detail(parsed.id!)), parsed.json)
      return 0
    }

    let sequence = 0
    let observations: { count: number, cursor: string } | undefined
    for (;;) {
      const detail = await target.detail(parsed.id!, observations)
      // An appended response holds only the observations after the previous count.
      const count = detail.appendObservations && observations ? observations.count + detail.observations.length : detail.observations.length
      observations = detail.observationCursor === undefined ? undefined : { count, cursor: detail.observationCursor }
      const record = detailRecord(detail)
      for (const observation of record.observations.filter(observation => observation.sequence > sequence)) {
        sequence = Math.max(sequence, observation.sequence)
        context.stdout.write(parsed.json ? `${JSON.stringify(observation)}\n` : `${observation.sequence} ${observation.timestamp} ${observation.name}\n`)
      }
      if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
        if (record.error) context.stderr.write(`${formatError(record.error)}\n`)
        return record.status === "completed" ? 0 : 1
      }
      await sleep(parsed.interval)
    }
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  finally {
    file?.close()
  }
}
