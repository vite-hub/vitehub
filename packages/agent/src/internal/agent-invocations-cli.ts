import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { discoverViteHubDevServer } from "@vite-hub/internal/cli"
import { asUnknownBoundary, hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"
import { isRuntimeRecord } from "./runtime-type.ts"
import type { AgentInvocationListResult, AgentInvocationRecord, AgentInvocationStore } from "../invocations.ts"
import type { AgentInvocationDetailResult } from "../invocations-vue.ts"
import type { RuntimeDiagnosticError } from "@vite-hub/runtime"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { isCompatibleAgentDevServerRoot } from "./agent-info-cli.ts"
import { agentInvocationsDevHeader, agentInvocationsDevHeaderValue, agentInvocationsDevRoute, agentInvocationsDevTokenServerHeader } from "../invocations-dev.ts"
import { readWorkspaceDevToken, workspaceDevTokenHeader } from "@vite-hub/workspace/server"

interface AgentInvocationsCliContext {
  env: NodeJS.ProcessEnv
  /** Resolves the default Console journal. Defaults to the current directory. */
  rootDir?: string
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

export interface AgentInvocationsCliOptions {
  fetch?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  timeout?: number
}

type Action = "cancel" | "delete" | "list" | "prune" | "show" | "tail"

const actions = new Set<string>(["cancel", "delete", "list", "prune", "show", "tail"] satisfies Action[])

function isAction(value: string): value is Action {
  return actions.has(value)
}

interface ParsedArgs {
  action?: Action
  database?: string
  dryRun: boolean
  help: boolean
  id?: string
  interval: number
  json: boolean
  limit?: number
  olderThanMs?: number
  status?: string
  tablePrefix?: string
  url: string
}

const defaultPruneAgeMs = 30 * 24 * 60 * 60 * 1000
const durationUnits: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, ms: 1, s: 1_000, w: 604_800_000 }

function usage(context: AgentInvocationsCliContext): void {
  context.stdout.write([
    "Usage: vitehub agent invocations <list|show|tail|cancel|delete|prune> [id] [options]",
    "",
    "list, show, and tail inspect an application's Agent Invocation journal over HTTP.",
    "delete and prune remove completed, failed, and cancelled records from a SQLite or libSQL journal.",
    "",
    "Options:",
    "  --url <url>              Invocation endpoint. Defaults to http://localhost:5173/api/invocations.",
    "  --status <status>        Filter list results by status.",
    "  --limit <count>          Limit list results.",
    "  --interval <ms>          Tail polling interval. Defaults to 1000.",
    "  --database <url>         Journal database for delete and prune. Defaults to the Console journal.",
    "  --table-prefix <prefix>  Journal table prefix. Defaults to vitehub_agent_.",
    "  --older-than <duration>  Prune records last updated before this age, such as 12h or 7d. Defaults to 30d.",
    "  --dry-run                List the records that prune would delete.",
    "  --json                   Print JSON or JSON Lines.",
    "  -h, --help               Show this help.",
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
    url: env.VITEHUB_AGENT_INVOCATIONS_URL || "http://localhost:5173/api/invocations",
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === "-h" || argument === "--help") parsed.help = true
    else if (argument === "--json") parsed.json = true
    else if (argument === "--dry-run") parsed.dryRun = true
    else if (argument === "--database") {
      parsed.database = optionValue(args, index, argument)
      index += 1
    }
    else if (argument.startsWith("--database=")) parsed.database = argument.slice(11)
    else if (argument === "--table-prefix") {
      parsed.tablePrefix = optionValue(args, index, argument)
      index += 1
    }
    else if (argument.startsWith("--table-prefix=")) parsed.tablePrefix = argument.slice(15)
    else if (argument === "--older-than") {
      parsed.olderThanMs = duration(optionValue(args, index, argument), argument)
      index += 1
    }
    else if (argument.startsWith("--older-than=")) parsed.olderThanMs = duration(argument.slice(13), "--older-than")
    else if (argument === "--url") {
      parsed.url = optionValue(args, index, argument)
      index += 1
    }
    else if (argument.startsWith("--url=")) parsed.url = argument.slice(6)
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
    else if (!parsed.action && isAction(argument)) parsed.action = argument
    else if (!parsed.id && parsed.action !== "list" && parsed.action !== "prune") parsed.id = argument
    else throw agentDiagnostics.AGENT_R0505({ message: `Unexpected argument: ${redactCliArgument(argument)}.` })
  }
  if (!parsed.help && !parsed.action) throw agentDiagnostics.AGENT_R0506({ message: "Choose list, show, tail, cancel, delete, or prune." })
  if (!parsed.help && parsed.action !== "list" && parsed.action !== "prune" && !parsed.id) throw agentDiagnostics.AGENT_R0507({ message: `${parsed.action} requires an invocation id.` })
  if (!parsed.help && parsed.dryRun && parsed.action !== "prune") throw agentDiagnostics.AGENT_R0505({ message: "--dry-run is only supported for prune." })
  return parsed
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
  if (!isRuntimeRecord(value) || !isInvocationSummary(value.invocation) || !Array.isArray(value.observations)) {
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

async function request<T>(url: URL, fetchImpl: typeof fetch, timeout: number, parseResponse: ResponseParser<T>): Promise<T> {
  const response = await fetchImpl(url.href, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw agentDiagnostics.AGENT_R0511({ message: (await response.text()).trim() || `Invocation inspection failed with status ${response.status}.` })
  const value: unknown = await response.json()
  return parseResponse(value)
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

function detailRecord(result: AgentInvocationDetailResult): AgentInvocationRecord {
  return { ...result.invocation, observations: result.observations }
}

async function cancelInvocation(parsed: ParsedArgs, context: AgentInvocationsCliContext, fetchImpl: typeof fetch, timeout: number): Promise<number> {
  const discoveryError = { value: "" }
  const server = await discoverViteHubDevServer<{ root?: unknown, workspaceDevTokenServerId?: unknown }>({
    endpoint: { header: agentInvocationsDevHeader, headerValue: agentInvocationsDevHeaderValue, route: agentInvocationsDevRoute },
    fetch: fetchImpl,
    isCompatibleRoot: isCompatibleAgentDevServerRoot,
    rootDir: resolve(context.rootDir ?? process.cwd()),
    serverUrl: parsed.url,
    signal: AbortSignal.timeout(timeout),
    stderr: { write: chunk => { discoveryError.value += String(chunk); return true } },
  })
  const serverId = server && hasRuntimeType(server.discovery.workspaceDevTokenServerId, "string")
    ? server.discovery.workspaceDevTokenServerId
    : undefined
  if (!server || !serverId) throw new Error(discoveryError.value.trim() || "No Compatible Vite Development Server found.")
  const target = new URL(server.url)
  const serverRoot = hasRuntimeType(server.discovery.root, "string") ? server.discovery.root : context.rootDir ?? process.cwd()
  const token = await readWorkspaceDevToken(serverRoot, { serverId })
  if (!token) throw new Error("No private Agent Dev token found. Start the Compatible Vite Development Server first.")
  target.pathname = agentInvocationsDevRoute
  target.search = ""
  target.hash = ""
  const response = await fetchImpl(target, {
    body: JSON.stringify({ id: parsed.id, operation: "cancel" }),
    headers: {
      "content-type": "application/json",
      [agentInvocationsDevHeader]: agentInvocationsDevHeaderValue,
      [agentInvocationsDevTokenServerHeader]: serverId,
      [workspaceDevTokenHeader]: token,
    },
    method: "POST",
    signal: AbortSignal.timeout(timeout),
  })
  const result: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = isRuntimeRecord(result) ? Reflect.get(result, "error") : undefined
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- HTTP error messages are untrusted JSON; only strings can enter CLI diagnostics.
    const message = isRuntimeRecord(error) && typeof Reflect.get(error, "message") === "string"
      // SAFETY: The record check and string check validate the message before this assertion.
      ? Reflect.get(error, "message") as string
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- HTTP errors may also be strings; only string values can enter CLI diagnostics.
      : typeof error === "string" ? error : undefined
    throw new Error(message || `Agent Invocation cancel failed (${response.status}).`)
  }
  const outcome: unknown = isRuntimeRecord(result) ? Reflect.get(result, "outcome") : undefined
  if (outcome !== "requested" && outcome !== "terminal" && outcome !== "not-found" && outcome !== "unavailable") {
    throw new Error("Agent Invocation cancel returned an invalid outcome.")
  }
  if (parsed.json) context.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else if (outcome === "requested") context.stdout.write(`Cancellation requested for ${parsed.id}.\n`)
  else if (outcome === "terminal") context.stdout.write(`Agent Invocation ${parsed.id} is already terminal.\n`)
  else context.stderr.write(outcome === "not-found"
    ? `Agent Invocation ${parsed.id} was not found.\n`
    : `Cancellation is unavailable for Agent Invocation ${parsed.id}.\n`)
  return outcome === "requested" || outcome === "terminal" ? 0 : 1
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
  const timeout = options.timeout ?? 30_000
  try {
    if (parsed.action === "delete") return await deleteInvocation(parsed, context, parsed.id!)
    if (parsed.action === "cancel") return await cancelInvocation(parsed, context, fetchImpl, timeout)
    if (parsed.action === "prune") return await pruneInvocations(parsed, context)
    if (parsed.action === "list") {
      const result = await request(endpoint(parsed), fetchImpl, timeout, parseInvocationList)
      if (parsed.json) context.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      else for (const record of result.invocations) context.stdout.write(`${summary(record)}\n`)
      return 0
    }
    if (parsed.action === "show") {
      writeRecord(context, detailRecord(await request(endpoint(parsed, parsed.id), fetchImpl, timeout, parseInvocationDetail)), parsed.json)
      return 0
    }

    const sleep = options.sleep || (async milliseconds => await new Promise(resolve => setTimeout(resolve, milliseconds)))
    let sequence = 0
    for (;;) {
      const record = detailRecord(await request(endpoint(parsed, parsed.id), fetchImpl, timeout, parseInvocationDetail))
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
