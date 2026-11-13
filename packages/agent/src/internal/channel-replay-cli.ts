import { callOperation, operationCredentialHint } from "@vite-hub/internal/operations"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } from "../invocation-stream.ts"
import { readAgentDevLoopTokenHeaders } from "./agent-info-cli.ts"
import { isRuntimeRecord } from "./runtime-type.ts"

interface ChannelReplayCliContext {
  env: NodeJS.ProcessEnv
  rootDir: string
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface ChannelReplayCliOptions {
  fetch?: typeof fetch
}

interface ParsedChannelReplayArgs {
  agent?: string
  channel?: string
  cursor?: string
  dryRun: boolean
  filters: Array<[string, string]>
  force: boolean
  help: boolean
  label?: string
  limit?: number
  queryFlags: Array<[string, string]>
  server?: string
  url?: string
}

/** The running Vite Development Server, or the deployed app that the `channels.replay` operation runs on. */
type ReplayTarget =
  | { remote: false, headers: Headers, url: string }
  | { remote: true, url: string }

/** Items per request. A small batch keeps each request within host time limits and reports progress often. */
const replayBatchSize = 10
const valueOptions = new Set(["--agent", "--channel", "--cursor", "--filter", "--label", "--query", "--limit", "--server", "--url"])

function cliError(message: string): Error {
  return agentDiagnostics.AGENT_R0934({ message })
}

function writeUsage(context: ChannelReplayCliContext, queryHelp: string[] = []): void {
  context.stdout.write([
    "Usage: vitehub channels replay --agent <name> --channel <name> [--url <console-url>] [--dry-run] [--force] [--limit <n>] [--cursor <cursor>] [--label <label>] [--query <key=value>]... [--filter <key=value>]... [--<query-key> <value>]...",
    "",
    "Send past Channel messages from the Channel's history Collection through its trigger.",
    "Without --url, the command uses the running Vite Development Server.",
    "",
    "Options:",
    "  --url <url>          Origin of the deployed app. The command calls its channels.replay operation. Set VITEHUB_CONSOLE_PRIVATE_KEY_<NAME> to sign the call.",
    "  --server <url>       Vite Development Server URL. Defaults to VITEHUB_DEV_SERVER_URL or http://localhost:5173.",
    "  --dry-run            Record Channel message writes in the trace instead of sending them.",
    "  --force              Replay items that already have an Invocation.",
    "  --limit <n>          Read at most n history items.",
    "  --cursor <cursor>    Continue from the cursor that an earlier replay printed.",
    "  --label <label>      Label retained Invocations. Non-empty, at most 512 characters.",
    "  --query <key=value>  Add a history query value. Repeatable, like --filter.",
    "  --filter <key=value> Add a history query value. The server validates it with the query schema.",
    ...(queryHelp.length ? ["", "History query:", ...queryHelp] : []),
    "",
  ].join("\n"))
}

export function parseChannelReplayArgs(args: string[]): ParsedChannelReplayArgs {
  const parsed: ParsedChannelReplayArgs = { dryRun: false, filters: [], force: false, help: false, queryFlags: [] }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") {
      parsed.help = true
      continue
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true
      continue
    }
    if (arg === "--force") {
      parsed.force = true
      continue
    }
    if (!arg.startsWith("--") || arg === "--") throw cliError(`Unexpected channels replay argument: ${arg}`)
    const separator = arg.indexOf("=")
    const name = separator === -1 ? arg : arg.slice(0, separator)
    let value = separator === -1 ? args[index + 1] : arg.slice(separator + 1)
    if (separator === -1) {
      if (value === undefined || value.startsWith("--")) throw cliError(`${name} requires a value.`)
      index++
    }
    value ??= ""
    if (!valueOptions.has(name)) {
      parsed.queryFlags.push([name.slice(2), value])
      continue
    }
    if (!value) throw cliError(`${name} requires a value.`)
    if (name === "--agent") parsed.agent = value
    else if (name === "--channel") parsed.channel = value
    else if (name === "--cursor") parsed.cursor = value
    else if (name === "--server") parsed.server = value
    else if (name === "--url") parsed.url = value
    else if (name === "--label") {
      if (!value.trim() || value.length > 512) throw cliError("--label must be a non-empty string of at most 512 characters.")
      parsed.label = value
    }
    else if (name === "--limit") {
      const limit = Number(value)
      if (!Number.isSafeInteger(limit) || limit < 1) throw cliError("--limit must be a positive integer.")
      parsed.limit = limit
    }
    else {
      const equals = value.indexOf("=")
      if (equals < 1) throw cliError(`${name} expects key=value.`)
      parsed.filters.push([value.slice(0, equals), value.slice(equals + 1)])
    }
  }
  return parsed
}

function baseUrl(value: string, label: string): URL {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw cliError(`${label} must be a URL.`)
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw cliError(`${label} must use HTTPS, except for localhost.`)
  if (url.username || url.password || url.search || url.hash) throw cliError(`${label} must not contain credentials, a query, or a fragment.`)
  return url
}

function replayTarget(parsed: ParsedChannelReplayArgs, env: NodeJS.ProcessEnv): ReplayTarget {
  if (parsed.url) return { remote: true, url: baseUrl(parsed.url, "--url").href }
  const server = baseUrl(parsed.server || env.VITEHUB_DEV_SERVER_URL || "http://localhost:5173", "--server")
  const headers = new Headers({ accept: "application/json", "content-type": "application/json", [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue })
  return { headers, remote: false, url: new URL(agentInvocationStreamRoute, server).href }
}

/** Time limit of one replay request. One request runs at most 10 Agent invocations. */
const replayTimeout = 15 * 60_000

async function sendReplay(target: ReplayTarget, agent: string, replay: Record<string, unknown>, context: ChannelReplayCliContext, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  if (target.remote) {
    // A deployed app runs the replay as the `channels.replay` operation on its Console RPC.
    const result = await callOperation({ env: context.env, fetch: fetchImpl, timeout: replayTimeout, url: target.url }, "channels.replay", { agent, ...replay })
    if (!result.ok) {
      if (result.status === 401 || result.status === 403) throw cliError(`Console authentication failed with HTTP ${result.status}: ${result.message} ${result.fix ?? operationCredentialHint}`)
      throw cliError(`Channel replay failed with HTTP ${result.status}: ${result.message}`)
    }
    if (!isRuntimeRecord(result.value)) throw cliError("Channel replay returned an invalid response.")
    return result.value
  }
  let response: Response
  try {
    response = await fetchImpl(target.url, {
      body: JSON.stringify({ agent, replay }),
      headers: target.headers,
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(replayTimeout),
    })
  }
  catch {
    throw cliError(`No Compatible Vite Development Server found at ${new URL(target.url).origin}.`)
  }
  const text = await response.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  }
  catch {
    json = undefined
  }
  if (!response.ok) {
    const message = isRuntimeRecord(json) && typeof json.message === "string" ? json.message : text.slice(0, 500)
    throw cliError(`Channel replay failed with HTTP ${response.status}${message ? `: ${message}` : "."}`)
  }
  if (!isRuntimeRecord(json)) throw cliError("Channel replay returned an invalid response.")
  return json
}

function schemaProperties(schema: unknown): Record<string, Record<string, unknown>> | undefined {
  if (!isRuntimeRecord(schema) || !isRuntimeRecord(schema.properties)) return
  const properties = Object.entries(schema.properties).flatMap(([name, value]) => isRuntimeRecord(value) ? [[name, value] as const] : [])
  return Object.fromEntries(properties)
}

/** One help line per query key, from the JSON Schema of the history query. */
export function channelReplayQueryHelp(schema: unknown): string[] {
  const properties = schemaProperties(schema)
  if (!properties) return ["  This history query has no JSON Schema. Use --filter key=value."]
  const required = isRuntimeRecord(schema) && Array.isArray(schema.required) ? schema.required : []
  return Object.entries(properties).map(([name, property]) => {
    const values = Array.isArray(property.enum) ? property.enum.map(String).join("|") : typeof property.type === "string" ? property.type : "value"
    const notes = [
      required.includes(name) ? "required" : undefined,
      property.type === "array" ? "repeatable" : undefined,
      typeof property.description === "string" ? property.description : undefined,
    ].filter(Boolean).join(", ")
    return `  ${valueOptions.has(`--${name}`) ? `--query ${name}=<${values}>` : `--${name} <${values}>`}${notes ? `  ${notes}` : ""}`
  })
}

/** Builds the Collection query from typed flags and --filter values. Repeated keys become arrays. */
export function channelReplayQuery(parsed: Pick<ParsedChannelReplayArgs, "filters" | "queryFlags">, schema: unknown): Record<string, string | string[]> {
  const properties = schemaProperties(schema)
  if (parsed.queryFlags.length && !properties) {
    throw cliError(`Unknown option --${parsed.queryFlags[0]![0]}. This history query has no JSON Schema; use --filter key=value.`)
  }
  const unknown = parsed.queryFlags.find(([name]) => !Object.hasOwn(properties || {}, name))
  if (unknown) {
    throw cliError(`Unknown option --${unknown[0]}. History query keys: ${Object.keys(properties || {}).join(", ") || "none"}.`)
  }
  const query: Record<string, string | string[]> = {}
  for (const [name, value] of [...parsed.queryFlags, ...parsed.filters]) {
    const current = query[name]
    query[name] = current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value]
  }
  return query
}

function writeItems(context: ChannelReplayCliContext, items: unknown): number {
  if (!Array.isArray(items)) return 0
  for (const item of items) {
    if (!isRuntimeRecord(item)) continue
    const reason = typeof item.reason === "string" ? ` (${item.reason})` : ""
    const error = typeof item.error === "string" ? `: ${item.error}` : ""
    context.stdout.write(`${String(item.status).padEnd(9)} ${String(item.key)}${reason}${error}\n`)
  }
  return items.length
}

function count(result: Record<string, unknown>, key: "failed" | "processed" | "skipped"): number {
  return typeof result[key] === "number" ? result[key] : 0
}

export async function runAgentChannelReplayCli(
  args: string[],
  context: ChannelReplayCliContext,
  options: ChannelReplayCliOptions = {},
): Promise<number> {
  try {
    const parsed = parseChannelReplayArgs(args)
    if (parsed.help && (!parsed.agent || !parsed.channel)) {
      writeUsage(context)
      return 0
    }
    const { agent, channel } = parsed
    if (!agent) throw cliError("channels replay requires --agent <name>.")
    if (!channel) throw cliError("channels replay requires --channel <name>.")
    const fetchImpl = options.fetch || globalThis.fetch
    const target = replayTarget(parsed, context.env)
    if (!target.remote) {
      const tokenHeaders = await readAgentDevLoopTokenHeaders(target.url, context.rootDir, fetchImpl, AbortSignal.timeout(30_000)).catch(() => {
        throw cliError(`No Compatible Vite Development Server found at ${new URL(target.url).origin}.`)
      })
      for (const [name, value] of Object.entries(tokenHeaders)) target.headers.set(name, value)
    }
    const description = await sendReplay(target, agent, { channel, describe: true }, context, fetchImpl)
    if (parsed.help) {
      writeUsage(context, channelReplayQueryHelp(description.query))
      return 0
    }
    const query = channelReplayQuery(parsed, description.query)
    const totals = { failed: 0, processed: 0, skipped: 0 }
    let cursor = parsed.cursor
    let remaining = parsed.limit ?? Number.POSITIVE_INFINITY
    const seenCursors = new Set<string>(cursor ? [cursor] : [])
    while (remaining > 0) {
      const result = await sendReplay(target, agent, {
        channel,
        ...(cursor ? { cursor } : {}),
        ...(parsed.dryRun ? { dryRun: true } : {}),
        ...(parsed.force ? { force: true } : {}),
        ...(parsed.label !== undefined ? { label: parsed.label } : {}),
        limit: Math.min(remaining, replayBatchSize),
        ...(Object.keys(query).length ? { query } : {}),
      }, context, fetchImpl)
      const read = writeItems(context, result.items)
      totals.failed += count(result, "failed")
      totals.processed += count(result, "processed")
      totals.skipped += count(result, "skipped")
      remaining -= read
      const nextCursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined
      if (nextCursor && seenCursors.has(nextCursor)) throw cliError("Channel replay returned a repeated pagination cursor.")
      if (nextCursor) seenCursors.add(nextCursor)
      cursor = nextCursor
      if (!cursor || !read) break
    }
    context.stdout.write(`Replayed ${totals.processed}, skipped ${totals.skipped}, failed ${totals.failed}.${parsed.dryRun ? " Dry run: Channel message writes were recorded, not sent." : ""}\n`)
    if (cursor) context.stdout.write(`More history remains. Continue with --cursor ${cursor}\n`)
    return totals.failed ? 1 : 0
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
