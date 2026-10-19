import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { asUnknownBoundary, hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"
import { discoverViteHubDevServer, fetchViteHubDevEndpoint, readViteHubDevTargetOption, resolveViteHubDevServerUrl } from "@vite-hub/internal/cli"
import { agentInvocationsDevGuard, agentInvocationsDevRoute, agentInvocationsDevRuntimeUnavailableMessage, agentInvocationsDevTokenServerHeader } from "../invocations-dev.ts"
import { readWorkspaceDevToken, workspaceDevTokenHeader } from "@vite-hub/workspace/server"
import { isCompatibleAgentDevServerRoot } from "./agent-info-cli.ts"
import type { AgentInvocationCancelResult, AgentInvocationListResult, AgentInvocationRecord, AgentInvocationStore } from "../invocations.ts"
import type { AgentInvocationsDevRequestBody } from "../invocations-dev.ts"
import type { AgentInvocationDetailResult } from "../invocations-vue.ts"
import type { RuntimeDiagnosticError } from "@vite-hub/runtime"
import { agentDiagnostics } from "../agent-diagnostics.ts"

interface AgentInvocationsCliContext {
  env: NodeJS.ProcessEnv
  /** Project root that the Compatible Vite Development Server must serve. Defaults to the current directory. */
  rootDir?: string
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

export interface AgentInvocationsCliOptions {
  fetch?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  timeout?: number
}

type Action = "delete" | "export" | "list" | "prune" | "show" | "tail"

const actions = new Set<string>(["delete", "export", "list", "prune", "show", "tail"] satisfies Action[])
/** Actions that read the whole journal instead of one record. */
const actionsWithoutId = new Set<string | undefined>(["export", "list", "prune"])

function isAction(value: string): value is Action {
  return actions.has(value)
}

interface ParsedArgs {
  action?: Action | "cancel"
  /** export only prints this Agent's Invocations. */
  agent?: string
  /** Base URL of a deployed Console. list, show, tail, and cancel then use its RPC endpoint. */
  console?: URL
  database?: string
  dryRun: boolean
  help: boolean
  id?: string
  interval: number
  json: boolean
  limit?: number
  /** export includes every observation. */
  observations: boolean
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
  urlSet: boolean
}

const cancelEndpoint = { ...agentInvocationsDevGuard, route: agentInvocationsDevRoute }

interface AgentInvocationsDevDiscovery {
  message?: unknown
  root?: unknown
  runtime?: unknown
  workspaceDevTokenServerId?: unknown
}

function parseCancelDiscovery(value: unknown): AgentInvocationsDevDiscovery {
  if (!isRuntimeRecord(value) || !hasRuntimeType(value.root, "string") || !hasRuntimeType(value.runtime, "string")
    || (value.message !== undefined && !hasRuntimeType(value.message, "string"))) {
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
const durationUnits: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, ms: 1, s: 1_000, w: 604_800_000 }

function usage(context: AgentInvocationsCliContext): void {
  context.stdout.write([
    "Usage: vitehub agent invocations <list|show|tail|export|cancel|delete|prune> [id] [options]",
    "",
    "list, show, tail, and cancel inspect or control an application's Agent Invocation journal.",
    "export prints one JSON line per Invocation, oldest first, for offline analysis and evals.",
    "delete and prune remove completed, failed, and cancelled records from a SQLite or libSQL journal.",
    "With a deployed --url, list, show, tail, and cancel use that deployment's Console. Otherwise",
    "cancel asks a running Vite + Nitro Development Server to cancel a pending or running Invocation.",
    "This command does not load the project config.",
    "",
    "Options:",
    "  --url <url>               Deployed app URL, such as https://app.example.com. Uses the Console RPC endpoint.",
    "                            Set VITEHUB_CONSOLE_AUTHORIZATION, VITEHUB_CONSOLE_COOKIE, or CF_ACCESS_CLIENT_ID and",
    "                            CF_ACCESS_CLIENT_SECRET to authenticate. A localhost URL uses the Console only for a",
    "                            /_vitehub path, such as http://localhost:3000/_vitehub.",
    "                            Other localhost URLs: the invocation endpoint for list, show, and tail",
    "                            (default http://localhost:5173/api/invocations), or the Development Server for cancel.",
    "  --server <url>            Vite Development Server URL for cancel. Defaults to VITEHUB_DEV_SERVER_URL or http://localhost:5173.",
    "  --timeout <ms>            Request timeout. Defaults to 30000.",
    "  --status <status>         Filter list results by pending, running, completed, failed, or cancelled.",
    "  --limit <count>           Limit list results.",
    "  --interval <ms>           Tail polling interval. Defaults to 1000.",
    "  --database <url>          Journal database for delete and prune. Defaults to the Console journal.",
    "  --table-prefix <prefix>   Journal table prefix. Defaults to vitehub_agent_.",
    "  --older-than <duration>   Prune records last updated before this age, such as 12h or 7d. Defaults to 30d.",
    "  --dry-run                 List the records that prune would delete.",
    "  --origin <origin>         export only Invocations with this origin, such as webhook.",
    "  --agent <name>            export only this Agent's Invocations.",
    "  --since <duration|date>   export only Invocations created after this age or ISO date, such as 7d or 2026-10-01.",
    "  --observations            export every observation too.",
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
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(value.trim())
  const result = match ? Number(match[1]) * durationUnits[match[2]!]! : Number.NaN
  if (!Number.isSafeInteger(result)) throw agentDiagnostics.AGENT_R0930({ message: `${flag} requires a duration such as 90m, 12h, or 30d.` })
  return result
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
    dryRun: false,
    help: false,
    interval: 1_000,
    json: false,
    observations: false,
    server: false,
    url: env.VITEHUB_AGENT_INVOCATIONS_URL || "http://localhost:5173/api/invocations",
    urlSet: false,
  }
  const target: { timeout?: number, url: string } = { url: parsed.url }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    const used = readViteHubDevTargetOption(args, index, target, devTargetErrors)
    if (used !== undefined) {
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
      parsed.interval = positiveInteger(optionValue(args, index, argument), argument)
      index += 1
    }
    else if (argument.startsWith("--interval=")) parsed.interval = positiveInteger(argument.slice(11), "--interval")
    else if (argument.startsWith("-")) throw agentDiagnostics.AGENT_R0504({ message: `Unknown option: ${redactCliArgument(argument)}.` })
    else if (!parsed.action && (argument === "cancel" || isAction(argument))) parsed.action = argument
    else if (!parsed.id && parsed.action && !actionsWithoutId.has(parsed.action)) parsed.id = argument
    else throw agentDiagnostics.AGENT_R0505({ message: `Unexpected argument: ${redactCliArgument(argument)}.` })
  }
  if (!parsed.help && !parsed.action) throw agentDiagnostics.AGENT_R0506({ message: "Choose list, show, tail, export, cancel, delete, or prune." })
  if (!parsed.help && !actionsWithoutId.has(parsed.action) && !parsed.id) throw agentDiagnostics.AGENT_R0507({ message: `${parsed.action} requires an invocation id.` })
  if (!parsed.help && parsed.dryRun && parsed.action !== "prune") throw agentDiagnostics.AGENT_R0505({ message: "--dry-run is only supported for prune." })
  const exportOnly = [["--origin", parsed.origin], ["--agent", parsed.agent], ["--since", parsed.since], ["--observations", parsed.observations || undefined]] as const
  const misplaced = exportOnly.find(([, value]) => value !== undefined)?.[0]
  if (!parsed.help && parsed.action !== "export" && misplaced) throw agentDiagnostics.AGENT_R0505({ message: `${misplaced} is only supported for export.` })
  if (parsed.action === "export" && parsed.status !== undefined && !invocationStatuses.has(parsed.status)) {
    throw agentDiagnostics.AGENT_R0503({ message: `--status must be one of ${[...invocationStatuses].join(", ")}.` })
  }
  if (!parsed.help && parsed.urlSet && !parsed.server && parsed.action !== "delete" && parsed.action !== "prune") {
    parsed.console = consoleBaseUrl(parsed.url)
  }
  if (parsed.console && parsed.status !== undefined && !invocationStatuses.has(parsed.status)) {
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
 * A deployed host, or any URL of a Console page such as `http://localhost:3000/_vitehub`, selects the Console.
 * Other loopback URLs keep their local meaning: the invocation endpoint, or the Vite Development Server for cancel.
 */
function consoleBaseUrl(value: string): URL | undefined {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    return
  }
  const consolePath = /(?:^|\/)_vitehub(?:\/|$)/.exec(url.pathname)
  const loopback = isLoopbackHost(url.hostname)
  if (loopback && !consolePath) return
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw agentDiagnostics.AGENT_R0503({ message: "--url must use HTTPS for a deployed Console, except for localhost." })
  }
  if (url.username || url.password || url.search || url.hash) {
    throw agentDiagnostics.AGENT_R0503({ message: "--url must not contain credentials, a query, or a fragment. Set VITEHUB_CONSOLE_AUTHORIZATION or VITEHUB_CONSOLE_COOKIE for credentials." })
  }
  // Accept the app URL or a pasted Console page URL. The RPC endpoint is under the app base.
  const base = consolePath ? url.pathname.slice(0, consolePath.index) : url.pathname
  url.pathname = base.endsWith("/") ? base : `${base}/`
  return url
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
    && hasRuntimeType(value.createdAt, "string")
    && hasRuntimeType(value.cursor, "string")
    && hasRuntimeType(value.id, "string")
    && hasRuntimeType(value.status, "string")
    && hasRuntimeType(value.traceId, "string")
    && hasRuntimeType(value.updatedAt, "string")
    && (value.error === undefined || isRuntimeRecord(value.error))
}

function parseInvocationList(value: unknown): AgentInvocationListResult {
  if (!isRuntimeRecord(value) || !Array.isArray(value.invocations) || value.invocations.some(record => !isInvocationSummary(record)) || value.cursor !== undefined && !hasRuntimeType(value.cursor, "string")) {
    throw agentDiagnostics.AGENT_R0508({ message: "Invocation inspection returned an invalid list response." })
  }
  // SAFETY: The list parser validates its cursor and every summary field consumed by the CLI.
  return asUnknownBoundary(value) as AgentInvocationListResult
}

function parseInvocationDetail(value: unknown): AgentInvocationDetailResult {
  if (!isRuntimeRecord(value) || !isInvocationSummary(value.invocation) || !Array.isArray(value.observations)
    || (value.observationCursor !== undefined && !hasRuntimeType(value.observationCursor, "string"))
    || (value.appendObservations !== undefined && !hasRuntimeType(value.appendObservations, "boolean"))) {
    throw agentDiagnostics.AGENT_R0509({ message: "Invocation inspection returned an invalid detail response." })
  }
  for (const observation of value.observations) {
    if (!isRuntimeRecord(observation) || !hasRuntimeType(observation.name, "string") || !hasRuntimeType(observation.sequence, "number") || !hasRuntimeType(observation.timestamp, "string")) {
      throw agentDiagnostics.AGENT_R0510({ message: "Invocation inspection returned an invalid observation." })
    }
  }
  // SAFETY: The detail parser validates the invocation summary and each observation field consumed by the CLI.
  return asUnknownBoundary(value) as AgentInvocationDetailResult
}

/** Console RPC contract owned by `vite-hub/console`. Its tests drive this client against the real handler. */
const consoleRpcCallPath = "_vitehub/rpc/__call"
const consoleRpcHeader = "x-vitehub-console"
const consoleRpcMethods = {
  invocation: "vitehub:console:invocation",
  invocations: "vitehub:console:invocations",
} as const
const consoleCredentialHint = "Set VITEHUB_CONSOLE_AUTHORIZATION, VITEHUB_CONSOLE_COOKIE, or CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET."
/** The Console returns at most 100 records per page. */
const consolePageLimit = 100
const consoleDefaultListLimit = 50

interface ConsoleRpcInput {
  body?: unknown
  id?: string
  method: "GET" | "POST"
  query?: Record<string, string>
}

interface ConsoleTarget {
  base: URL
  env: NodeJS.ProcessEnv
  fetch: typeof fetch
  timeout: number
}

function consoleHeaders(env: NodeJS.ProcessEnv): Headers {
  // The Console header proves a non-browser caller, because a foreign page cannot send it without a CORS preflight.
  const headers = new Headers({ "accept": "application/json", "content-type": "application/json", [consoleRpcHeader]: "1" })
  if (env.VITEHUB_CONSOLE_AUTHORIZATION) headers.set("authorization", env.VITEHUB_CONSOLE_AUTHORIZATION)
  if (env.VITEHUB_CONSOLE_COOKIE) headers.set("cookie", env.VITEHUB_CONSOLE_COOKIE)
  if (env.CF_ACCESS_CLIENT_ID) headers.set("cf-access-client-id", env.CF_ACCESS_CLIENT_ID)
  if (env.CF_ACCESS_CLIENT_SECRET) headers.set("cf-access-client-secret", env.CF_ACCESS_CLIENT_SECRET)
  return headers
}

function hasConsoleCredentials(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEHUB_CONSOLE_AUTHORIZATION || env.VITEHUB_CONSOLE_COOKIE || env.CF_ACCESS_CLIENT_ID || env.CF_ACCESS_CLIENT_SECRET)
}

/** Send one Console RPC call. A failure becomes an error with the HTTP status and the Console message. */
async function consoleCall<T>(target: ConsoleTarget, method: string, input: ConsoleRpcInput, parseResponse: ResponseParser<T>): Promise<T> {
  const url = new URL(consoleRpcCallPath, target.base)
  let response: Response
  try {
    response = await target.fetch(url.href, {
      body: JSON.stringify({ input, method }),
      headers: consoleHeaders(target.env),
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(target.timeout),
    })
  }
  catch (error) {
    throw agentDiagnostics.AGENT_R0511({ message: `Console request to ${url.origin} failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  const text = await response.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  }
  catch {
    json = undefined
  }
  if (response.ok && isRuntimeRecord(json) && json.ok === true) return parseResponse(json.value)
  const message = isRuntimeRecord(json) && hasRuntimeType(json.message, "string") && json.message ? json.message.replace(/\.$/, "") : undefined
  const status = response.ok && isRuntimeRecord(json) && hasRuntimeType(json.status, "number") ? json.status : response.status
  if (status === 401 || (status >= 300 && status < 400)) {
    throw agentDiagnostics.AGENT_R0511({ message: `Console authentication failed with HTTP ${status}${message ? `: ${message}` : ""}. ${consoleCredentialHint}` })
  }
  if (status === 403) {
    throw agentDiagnostics.AGENT_R0511({ message: `Console denied the request with HTTP 403${message ? `: ${message}` : ""}.${hasConsoleCredentials(target.env) ? "" : ` ${consoleCredentialHint}`}` })
  }
  if (!isRuntimeRecord(json)) {
    throw agentDiagnostics.AGENT_R0511({ message: `${url.origin}${target.base.pathname} did not answer as a ViteHub Console (HTTP ${status}). Pass the app URL of a deployment that enables the Console.` })
  }
  throw agentDiagnostics.AGENT_R0511({ message: `Console request failed with HTTP ${status}${message ? `: ${message}` : ""}.` })
}

type InvocationSummary = AgentInvocationListResult["invocations"][number]

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
    const query: Record<string, string> = { limit: String(Math.min(consolePageLimit, statuses ? consolePageLimit : wanted - collected)) }
    if (cursor !== undefined) query.cursor = cursor
    return await consoleCall(target, consoleRpcMethods.invocations, { method: "GET", query }, parseInvocationList)
  }, record => !statuses || statuses.has(record.status), wanted)
}

interface InvocationsTarget {
  cancel: (id: string) => Promise<AgentInvocationCancelResult | undefined>
  /** Read one record. Pass the previous count and cursor to receive only new observations when the server supports it. */
  detail: (id: string, observations?: { count: number, cursor: string }) => Promise<AgentInvocationDetailResult>
  list: () => Promise<AgentInvocationListResult>
  /** Every record with one of these statuses, following list cursors to the end. */
  scan: (statuses: readonly string[]) => Promise<InvocationSummary[]>
}

function consoleInvocationsTarget(target: ConsoleTarget, parsed: ParsedArgs): InvocationsTarget {
  return {
    cancel: async id => await consoleCall(target, consoleRpcMethods.invocation, { body: { action: "cancel" }, id, method: "POST" }, parseCancelResult),
    detail: async (id, observations) => await consoleCall(target, consoleRpcMethods.invocation, {
      id,
      method: "GET",
      query: observations === undefined
        ? undefined
        : { observationCount: String(observations.count), observationCursor: observations.cursor },
    }, parseInvocationDetail),
    list: async () => ({
      invocations: await listConsoleInvocations(target, parsed.limit ?? consoleDefaultListLimit, parsed.status ? new Set([parsed.status]) : undefined),
    }),
    // One pass over the Console pages serves every status.
    scan: async statuses => await listConsoleInvocations(target, Number.POSITIVE_INFINITY, new Set(statuses)),
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
    scan: async (statuses) => {
      const records = new Map<string, InvocationSummary>()
      for (const status of statuses) {
        const page = async (cursor: string | undefined) => {
          const url = new URL(parsed.url)
          url.searchParams.set("status", status)
          if (cursor !== undefined) url.searchParams.set("cursor", cursor)
          return await request(url, fetchImpl, timeout, parseInvocationList)
        }
        // A record can change status between two reads. Keep its latest summary once.
        for (const record of await collectPages(page, record => record.status === status)) records.set(record.id, record)
      }
      return [...records.values()]
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
    || !hasRuntimeType(value.id, "string")
    || !cancelOutcomes.has(value.outcome)
    || (value.status !== undefined && !hasRuntimeType(value.status, "string"))
    || (value.notEnforcedBy !== undefined && !hasRuntimeType(value.notEnforcedBy, "string"))
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
    context.stderr.write(`${hasRuntimeType(discovery.message, "string") ? discovery.message : agentInvocationsDevRuntimeUnavailableMessage}\n`)
    return
  }
  const body: AgentInvocationsDevRequestBody = { id, operation: "cancel" }
  if (!hasRuntimeType(discovery.workspaceDevTokenServerId, "string")) {
    throw agentDiagnostics.AGENT_R0971({ message: "Invocation cancellation discovery did not publish a token server ID." })
  }
  const token = await readWorkspaceDevToken(hasRuntimeType(discovery.root, "string") ? discovery.root : rootDir, { serverId: discovery.workspaceDevTokenServerId })
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
    if (hasRuntimeType(message, "string") && message) return message
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
  const explicit = parsed.database?.trim() || context.env.VITEHUB_AGENT_INVOCATIONS_DATABASE_URL?.trim()
  const configured = explicit || context.env.VITEHUB_CONSOLE_DATABASE_URL?.trim()
  const authToken = explicit
    ? context.env.VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN
    : context.env.VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN
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
  const target = configured || resolve(root, ".vitehub/data/console.sqlite")
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

async function withJournalStore<T>(parsed: ParsedArgs, context: AgentInvocationsCliContext, use: (store: AgentInvocationStore) => Promise<T>): Promise<T> {
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
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false, ...(parsed.tablePrefix === undefined ? {} : { tablePrefix: parsed.tablePrefix }) })
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

type Observation = AgentInvocationRecord["observations"][number]

function observationAttributes(observations: readonly Observation[], name: string): Record<string, unknown>[] {
  return observations.flatMap(observation => observation.name === name ? [observation.attributes ?? {}] : [])
}

/**
 * One export line: the record without observations, plus the prompt, the final assistant text, and each Channel
 * delivery that the observations carry. `final` is the finish result text, or the final message deltas before finish.
 */
function exportLine(record: AgentInvocationRecord, includeObservations: boolean) {
  const { cursor: _cursor, observations, ...invocation } = record
  const start = observationAttributes(observations, "agent.invocation.start")[0] ?? {}
  const finish = observationAttributes(observations, "agent.invocation.finish").at(-1)?.["result.text"]
  const finalDeltaGroups = new Map<string, { sequence: number, text: string }>()
  observations.forEach((observation, index) => {
    if (observation.name !== "agent.message.delta") return
    const delta = observation.attributes ?? {}
    if (delta["message.phase"] !== "final" && delta["message.phase"] !== "final_answer") return
    const id = hasRuntimeType(delta["message.id"], "string") ? delta["message.id"] : "__anonymous"
    const group = finalDeltaGroups.get(id) ?? { sequence: index, text: "" }
    group.sequence = index
    if (hasRuntimeType(delta["message.content"], "string")) group.text += delta["message.content"]
    finalDeltaGroups.set(id, group)
  })
  const deltas = [...finalDeltaGroups.values()].sort((left, right) => right.sequence - left.sequence)[0]?.text
  return {
    ...invocation,
    runId: start["agent.run.id"],
    prompt: start["input.prompt"],
    final: hasRuntimeType(finish, "string") ? finish : deltas || undefined,
    deliveries: observationAttributes(observations, "agent.channel.delivery.effect").map(effect => ({
      channel: hasRuntimeType(effect["channel.effect.channel"], "string") ? effect["channel.effect.channel"] : "unknown",
      content: effect["channel.effect.content"],
      intent: effect["channel.effect.intent"],
      kind: effect["channel.effect.kind"],
      ...(effect["channel.effect.skipped"] === undefined ? {} : { skipped: effect["channel.effect.skipped"] }),
    })),
    ...(includeObservations ? { observations } : {}),
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
    context.stdout.write(`${JSON.stringify(exportLine(detailRecord(await target.detail(summary.id)), parsed.observations))}\n`)
  }
  return 0
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
  const target = parsed.console
    ? consoleInvocationsTarget({ base: parsed.console, env: context.env, fetch: fetchImpl, timeout }, parsed)
    : localInvocationsTarget(parsed, context, fetchImpl, timeout)
  try {
    if (parsed.action === "cancel") {
      const result = await target.cancel(parsed.id!)
      if (!result) return 1
      context.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${cancelMessage(result)}\n`)
      return cancelExitCode(result)
    }
    if (parsed.action === "delete") return await deleteInvocation(parsed, context, parsed.id!)
    if (parsed.action === "prune") return await pruneInvocations(parsed, context)
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

    const sleep = options.sleep || (async milliseconds => await new Promise(resolve => setTimeout(resolve, milliseconds)))
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
}
