import type { AgentInvocationListResult, AgentInvocationRecord } from "../invocations.ts"
import type { AgentInvocationDetailResult } from "../invocations-vue.ts"

interface AgentInvocationsCliContext {
  env: NodeJS.ProcessEnv
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

export interface AgentInvocationsCliOptions {
  fetch?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  timeout?: number
}

interface ParsedArgs {
  action?: "list" | "show" | "tail"
  help: boolean
  id?: string
  interval: number
  json: boolean
  limit?: number
  status?: string
  url: string
}

function usage(context: AgentInvocationsCliContext): void {
  context.stdout.write([
    "Usage: vitehub agent invocations <list|show|tail> [id] [options]",
    "",
    "Inspect an application's Agent Invocation journal over HTTP.",
    "",
    "Options:",
    "  --url <url>       Invocation endpoint. Defaults to http://localhost:5173/api/invocations.",
    "  --status <status> Filter list results by status.",
    "  --limit <count>   Limit list results.",
    "  --interval <ms>   Tail polling interval. Defaults to 1000.",
    "  --json            Print JSON or JSON Lines.",
    "  -h, --help        Show this help.",
    "",
  ].join("\n"))
}

function optionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("-")) throw new Error(`Missing value for ${flag}.`)
  return value
}

function positiveInteger(value: string, flag: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${flag} requires a positive integer.`)
  return result
}

function parse(args: string[], env: NodeJS.ProcessEnv): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    interval: 1_000,
    json: false,
    url: env.VITEHUB_AGENT_INVOCATIONS_URL || "http://localhost:5173/api/invocations",
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === "-h" || argument === "--help") parsed.help = true
    else if (argument === "--json") parsed.json = true
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
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}.`)
    else if (!parsed.action && (argument === "list" || argument === "show" || argument === "tail")) parsed.action = argument
    else if (!parsed.id) parsed.id = argument
    else throw new Error(`Unexpected argument: ${argument}.`)
  }
  if (!parsed.help && !parsed.action) throw new Error("Choose list, show, or tail.")
  if (!parsed.help && parsed.action !== "list" && !parsed.id) throw new Error(`${parsed.action} requires an invocation id.`)
  return parsed
}

function endpoint(parsed: ParsedArgs, id?: string): URL {
  const base = new URL(parsed.url)
  if (id) base.pathname = `${base.pathname.replace(/\/$/, "")}/${encodeURIComponent(id)}`
  if (!id && parsed.status) base.searchParams.set("status", parsed.status)
  if (!id && parsed.limit) base.searchParams.set("limit", String(parsed.limit))
  return base
}

async function request<T>(url: URL, fetchImpl: typeof fetch, timeout: number): Promise<T> {
  const response = await fetchImpl(url.href, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error((await response.text()).trim() || `Invocation inspection failed with status ${response.status}.`)
  return await response.json() as T
}

function summary(record: AgentInvocationRecord | AgentInvocationListResult["invocations"][number]): string {
  const error = record.error ? ` ${record.error.name || "Error"}: ${record.error.message}` : ""
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
  const timeout = options.timeout ?? 30_000
  try {
    if (parsed.action === "list") {
      const result = await request<AgentInvocationListResult>(endpoint(parsed), fetchImpl, timeout)
      if (parsed.json) context.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      else for (const record of result.invocations) context.stdout.write(`${summary(record)}\n`)
      return 0
    }
    if (parsed.action === "show") {
      writeRecord(context, detailRecord(await request<AgentInvocationDetailResult>(endpoint(parsed, parsed.id), fetchImpl, timeout)), parsed.json)
      return 0
    }

    const sleep = options.sleep || (async milliseconds => await new Promise(resolve => setTimeout(resolve, milliseconds)))
    let sequence = 0
    for (;;) {
      const record = detailRecord(await request<AgentInvocationDetailResult>(endpoint(parsed, parsed.id), fetchImpl, timeout))
      for (const observation of record.observations.filter(observation => observation.sequence > sequence)) {
        sequence = Math.max(sequence, observation.sequence)
        context.stdout.write(parsed.json ? `${JSON.stringify(observation)}\n` : `${observation.sequence} ${observation.timestamp} ${observation.name}\n`)
      }
      if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
        if (record.error) context.stderr.write(`${record.error.name || "Error"}: ${record.error.message}\n`)
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
