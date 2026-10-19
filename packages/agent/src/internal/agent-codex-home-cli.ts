import { resolve } from "node:path"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { inventoryCodexHome, measureCodexHome, pruneCodexHome } from "./codex-home-retention.ts"
import { parseRetentionDuration, parseRetentionSize } from "./retention-policy.ts"

import type { CodexHomeRetentionReport } from "./codex-home-retention.ts"
import type { NormalizedRetention, RetentionSizeLimit } from "./retention-policy.ts"

interface AgentCodexHomeCliContext {
  env: NodeJS.ProcessEnv
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface ParsedArgs {
  action?: "prune" | "status"
  dryRun: boolean
  help: boolean
  home?: string
  json: boolean
  policy: NormalizedRetention
  sessionStores: string[]
}

function usage(context: AgentCodexHomeCliContext): void {
  context.stdout.write([
    "Usage: vitehub agent codex-home <status|prune> --home <path> [options]",
    "",
    "status measures a Codex home: sessions, SQLite databases, and temporary files.",
    "With limits, it also shows what prune would remove. prune removes the oldest data until every limit holds,",
    "with the same rules and lock file as driver.retention. This command does not load the project config.",
    "",
    "Options:",
    "  --home <path>             Codex home. Defaults to CODEX_HOME.",
    "  --max-age <duration>      Remove sessions, log rows, and shell snapshots older than this, such as 14d.",
    "  --max-records <count>     Keep at most this many sessions.",
    "  --max-size <size>         Keep the home within this size, such as 2GB or a number of bytes,",
    "                            or this percent of its volume, such as 45%.",
    "  --session-store <path>    Provider session store (driver.sessionStorePath). Its sessions go last.",
    "                            Repeat it for more stores.",
    "  --dry-run                 Show what prune would remove. Change nothing.",
    "  --json                    Print JSON.",
    "  -h, --help                Show this help.",
    "",
  ].join("\n"))
}

function optionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("-")) throw agentDiagnostics.AGENT_R0502({ message: `Missing value for ${flag}.` })
  return value
}

function maxAge(value: string): number {
  const result = parseRetentionDuration(value)
  if (result === undefined) throw agentDiagnostics.AGENT_R0930({ message: "--max-age requires a duration such as 12h or 14d." })
  return result
}

function maxRecords(value: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result <= 0) throw agentDiagnostics.AGENT_R0503({ message: "--max-records requires a positive integer." })
  return result
}

function maxSize(value: string): RetentionSizeLimit {
  // A bare integer is a number of bytes, as in the maxSize option.
  const bytes = /^\d+$/.test(value.trim()) ? Number(value) : undefined
  const result = bytes !== undefined && Number.isSafeInteger(bytes) && bytes >= 1 ? { bytes } : parseRetentionSize(value)
  if (result === undefined) throw agentDiagnostics.AGENT_R0930({ message: "--max-size requires a size such as 500MB or 2GB, a number of bytes, or a percent of the volume such as 45%." })
  return result
}

function parse(args: string[], env: NodeJS.ProcessEnv): ParsedArgs {
  const parsed: ParsedArgs = {
    dryRun: false,
    help: false,
    json: false,
    policy: { maxAgeMs: false, maxRecords: false, maxSize: false },
    sessionStores: [],
  }
  const options: Record<string, (value: string) => void> = {
    "--home": (value) => { parsed.home = value },
    "--max-age": (value) => { parsed.policy.maxAgeMs = maxAge(value) },
    "--max-records": (value) => { parsed.policy.maxRecords = maxRecords(value) },
    "--max-size": (value) => { parsed.policy.maxSize = maxSize(value) },
    "--session-store": (value) => { parsed.sessionStores.push(value) },
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    const [flag, inline] = argument.startsWith("--") && argument.includes("=") ? [argument.slice(0, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)] : [argument, undefined]
    const option = options[flag]
    if (option) {
      if (inline !== undefined) option(inline)
      else {
        option(optionValue(args, index, flag))
        index += 1
      }
    }
    else if (argument === "-h" || argument === "--help") parsed.help = true
    else if (argument === "--json") parsed.json = true
    else if (argument === "--dry-run") parsed.dryRun = true
    else if (argument.startsWith("-")) throw agentDiagnostics.AGENT_R0504({ message: `Unknown option: ${flag}.` })
    else if (!parsed.action && (argument === "status" || argument === "prune")) parsed.action = argument
    else throw agentDiagnostics.AGENT_R0505({ message: `Unexpected argument: ${argument}.` })
  }
  if (parsed.help) return parsed
  if (!parsed.action) throw agentDiagnostics.AGENT_R0506({ message: "Choose status or prune." })
  parsed.home ??= env.CODEX_HOME?.trim() || undefined
  if (!parsed.home) throw agentDiagnostics.AGENT_R0505({ message: "Pass --home <path> or set CODEX_HOME." })
  if (parsed.dryRun && parsed.action !== "prune") throw agentDiagnostics.AGENT_R0505({ message: "--dry-run is only supported for prune." })
  const { maxAgeMs, maxRecords: records, maxSize: size } = parsed.policy
  if (parsed.action === "prune" && maxAgeMs === false && records === false && size === false) {
    throw agentDiagnostics.AGENT_R0505({ message: "prune requires --max-age, --max-records, or --max-size." })
  }
  return parsed
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

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function writeReport(context: AgentCodexHomeCliContext, report: CodexHomeRetentionReport): void {
  const { after, before, removed } = report
  const verb = report.dryRun ? "Would remove" : "Removed"
  context.stdout.write(`${verb} ${plural(removed.sessions, "session")}, ${plural(removed.logRows, "log row")}, ${plural(removed.snapshots, "shell snapshot")}, and ${plural(removed.tmpEntries, "temporary entry", "temporary entries")}.\n`)
  if (!report.dryRun) context.stdout.write(`Removed ${plural(removed.threadRows, "thread row")} from the Codex databases.\n`)
  context.stdout.write(`Size: ${formatBytes(before.bytes)} before, ${formatBytes(after.bytes)} ${report.dryRun ? "projected" : "after"}`)
  context.stdout.write(report.budgetBytes === undefined ? ".\n" : `, budget ${formatBytes(report.budgetBytes)}.\n`)
  context.stdout.write(`Sessions: ${before.records} before, ${after.records} ${report.dryRun ? "projected" : "after"}.\n`)
  if (report.protected.active || report.protected.referenced) {
    context.stdout.write(`Kept ${report.protected.active} active or recent sessions and ${report.protected.referenced} sessions that a resume cursor references.\n`)
  }
  if (report.overBudget) context.stdout.write("The home is still above the budget. Only protected data remains, or a step stopped early.\n")
  for (const reason of report.skipped) context.stdout.write(`Skipped: ${reason}\n`)
}

async function status(parsed: ParsedArgs, home: string, context: AgentCodexHomeCliContext): Promise<number> {
  const inventory = await inventoryCodexHome(home)
  const measure = measureCodexHome(inventory)
  const sum = (entries: readonly { bytes: number }[]) => entries.reduce((total, entry) => total + entry.bytes, 0)
  const { maxAgeMs, maxRecords: records, maxSize: size } = parsed.policy
  const prune = maxAgeMs === false && records === false && size === false
    ? undefined
    : await pruneCodexHome({ dryRun: true, home, policy: parsed.policy, sessionStorePaths: parsed.sessionStores })
  const result = {
    databases: inventory.databases.map(database => ({ diskBytes: database.diskBytes, liveBytes: database.liveBytes, name: database.name, walBytes: database.walBytes })),
    home,
    ...measure,
    ...(prune ? { prune } : {}),
    sessions: { bytes: sum(inventory.rollouts), count: inventory.rollouts.length },
    skipped: inventory.skipped,
    snapshots: { bytes: sum(inventory.snapshots), count: inventory.snapshots.length },
    tmpEntries: { bytes: sum(inventory.tmpEntries), count: inventory.tmpEntries.length },
  }
  if (parsed.json) {
    context.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  context.stdout.write(`Codex home ${home}: ${formatBytes(measure.bytes)} counted, ${formatBytes(measure.diskBytes)} on disk.\n`)
  context.stdout.write(`Sessions: ${result.sessions.count} (${formatBytes(result.sessions.bytes)}).\n`)
  for (const database of result.databases) {
    context.stdout.write(`${database.name}: ${formatBytes(database.liveBytes)} live, ${formatBytes(database.walBytes)} WAL, ${formatBytes(database.diskBytes)} on disk.\n`)
  }
  context.stdout.write(`Shell snapshots: ${result.snapshots.count} (${formatBytes(result.snapshots.bytes)}). Temporary entries: ${result.tmpEntries.count} (${formatBytes(result.tmpEntries.bytes)}).\n`)
  for (const reason of inventory.skipped) context.stdout.write(`Skipped: ${reason}\n`)
  if (prune) writeReport(context, prune)
  return 0
}

/** `vitehub agent codex-home`: measures and prunes a Codex home without the app. */
export async function runAgentCodexHomeCli(args: string[], context: AgentCodexHomeCliContext): Promise<number> {
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
  const home = resolve(parsed.home!)
  try {
    if (parsed.action === "status") return await status(parsed, home, context)
    const report = await pruneCodexHome({ dryRun: parsed.dryRun, home, policy: parsed.policy, sessionStorePaths: parsed.sessionStores })
    if (parsed.json) context.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else writeReport(context, report)
    return report.skipped.some(reason => reason.startsWith("Another process holds")) ? 1 : 0
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
