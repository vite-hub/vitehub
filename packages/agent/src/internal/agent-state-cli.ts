import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { formatRuntimeDiagnosticError } from "@vite-hub/runtime"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { createLibsqlAgentState } from "../state/sqlite.ts"
import { chatStateAgentPrefix, chatStateChannelPrefix, chatStateScopedKey } from "./chat-state-scope.ts"

import type { SqliteAgentStateExtensionExecutor } from "../state/sqlite.ts"

interface AgentStateCliContext {
  env: NodeJS.ProcessEnv
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface ParsedArgs {
  agent: string
  apply: boolean
  /** Adapter name to the Channel id that scopes its keys. */
  channels: Map<string, string>
  tablePrefix: string
  url: string
}

type StateTable = "cache" | "lists" | "queue" | "subscriptions"

interface StateKeyMove {
  from: string
  table: StateTable
  to: string
}

interface StateMigrationPlan {
  conflicts: StateKeyMove[]
  /** Unscoped locks. They expire, so the command leaves them. */
  locks: number
  moves: StateKeyMove[]
  /** Unscoped keys that name no listed adapter. */
  unmatched: string[]
}

const usageText = "vitehub agent state migrate --agent <name> --channel <adapter>[=<channel>]... [--url <libsql-url>] [--table-prefix <prefix>] [--apply]"

/** Key prefixes that ViteHub scopes itself. A key that starts with one of them is never an unscoped Chat key. */
const scopedKeyPrefixes = new Set(["chat", "transcripts", "webhook"])

const keyColumns: Record<StateTable, string> = { cache: "key", lists: "key", queue: "thread_id", subscriptions: "thread_id" }

function usage(context: AgentStateCliContext): void {
  context.stdout.write(`Usage: ${usageText}

Moves Chat State keys that an explicit \`messages.state\` wrote without a scope to the
Channel scope of the provider default State. Stop the app first. Without --apply, the
command only prints the moves.

  --agent <name>                 Agent that owns the keys.
  --channel <adapter>[=<channel>] Adapter name in the keys, and the Channel id when it differs.
  --url <libsql-url>             Agent State database. Defaults to VITEHUB_AGENT_STATE_URL.
  --table-prefix <prefix>        Table prefix of the State. Defaults to vitehub_agent_state_.
  --apply                        Move the keys.
`)
}

function parse(args: string[], env: NodeJS.ProcessEnv): ParsedArgs | "help" {
  const invalid = (reason: string) => agentDiagnostics.AGENT_STATE_MIGRATE_ARGUMENT_INVALID({ reason })
  const parsed: ParsedArgs = { agent: "", apply: false, channels: new Map(), tablePrefix: "vitehub_agent_state_", url: env.VITEHUB_AGENT_STATE_URL || "" }
  let action: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === "--help" || argument === "-h") return "help"
    if (argument === "--apply") {
      parsed.apply = true
      continue
    }
    const [flag, inline] = argument.startsWith("--") && argument.includes("=") ? [argument.slice(0, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)] : [argument, undefined]
    if (["--agent", "--channel", "--table-prefix", "--url"].includes(flag)) {
      const value = inline ?? args[++index]
      if (!value || (inline === undefined && value.startsWith("--"))) throw invalid(`${flag} needs a value.`)
      if (flag === "--agent") parsed.agent = value
      if (flag === "--table-prefix") parsed.tablePrefix = value
      if (flag === "--url") parsed.url = value
      if (flag === "--channel") {
        const [adapter, channel = adapter] = value.split("=", 2)
        if (!adapter || !channel) throw invalid(`--channel ${value} needs an adapter name, such as --channel teams or --channel teams=support.`)
        parsed.channels.set(adapter, channel)
      }
      continue
    }
    if (argument.startsWith("-")) throw invalid(`Unknown option ${argument}.`)
    if (action) throw invalid(`Unexpected argument ${argument}.`)
    action = argument
  }
  if (action === undefined) return "help"
  if (action !== "migrate") throw invalid(`Unknown action ${action}. Use migrate.`)
  if (!parsed.agent) throw invalid("Pass --agent with the name of the Agent that owns the keys.")
  if (!parsed.channels.size) throw invalid("Pass --channel for each adapter whose keys move, such as --channel teams.")
  if (!parsed.url) throw invalid("Pass --url with the Agent State database, or set VITEHUB_AGENT_STATE_URL.")
  // A plain path names a local file, as in `file:` URLs.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(parsed.url)) parsed.url = `file:${parsed.url}`
  return parsed
}

function localFilePath(url: string): string | undefined {
  if (!/^file:/i.test(url)) return
  const path = /^file:\/\//i.test(url) ? fileURLToPath(url) : decodeURIComponent(url.slice(5).split(/[?#]/, 1)[0]!)
  return path === ":memory:" ? undefined : resolve(path)
}

function keyAdapter(key: string, channels: ReadonlyMap<string, string>): string | undefined {
  // Chat SDK concurrency keys are `concurrency:["<adapter>",<scope>,<key>]`.
  const concurrency = /^concurrency:\["([^"\\]*)"/.exec(key)
  if (concurrency) return channels.has(concurrency[1]!) ? concurrency[1] : undefined
  // Thread ids start with the adapter name, such as `teams:<conversation>`. Other Chat keys put one word before it,
  // such as `thread-state:teams:<conversation>` or `dedupe:teams:<message>`.
  const [first = "", second] = key.split(":", 2)
  if (channels.has(first)) return first
  if (second !== undefined && !scopedKeyPrefixes.has(first) && channels.has(second)) return second
}

/** The key that the provider default State reads for an unscoped key, or undefined when no listed Channel owns it. */
function scopedChatStateKey(key: string, agent: string, channels: ReadonlyMap<string, string>): string | undefined {
  const adapter = keyAdapter(key, channels)
  const channel = adapter === undefined ? undefined : channels.get(adapter)
  if (channel === undefined && !key.startsWith("transcripts:user:")) return
  return chatStateScopedKey(key, chatStateAgentPrefix(agent), chatStateChannelPrefix(agent, channel ?? ""))
}

async function tableKeys(tx: SqliteAgentStateExtensionExecutor, table: string, column: string): Promise<string[]> {
  return (await tx.execute(`SELECT DISTINCT ${column} AS key FROM ${table}`)).map(row => String(row.key))
}

async function planMigration(tx: SqliteAgentStateExtensionExecutor, parsed: ParsedArgs): Promise<StateMigrationPlan> {
  const plan: StateMigrationPlan = { conflicts: [], locks: 0, moves: [], unmatched: [] }
  const unmatched = new Set<string>()
  for (const table of ["cache", "lists", "queue", "subscriptions"] as const) {
    const keys = await tableKeys(tx, `${parsed.tablePrefix}${table}`, keyColumns[table])
    const existing = new Set(keys)
    for (const key of keys) {
      if (key.startsWith(chatStateAgentPrefix(parsed.agent)) || key.startsWith("webhook:")) continue
      const to = scopedChatStateKey(key, parsed.agent, parsed.channels)
      if (!to) {
        unmatched.add(key)
        continue
      }
      // Queue entries append to the scoped queue, and a subscription is the same in both scopes.
      // A cache value or a list would replace newer data, so it stays.
      const conflict = (table === "cache" || table === "lists") && existing.has(to)
      plan[conflict ? "conflicts" : "moves"].push({ from: key, table, to })
    }
  }
  for (const key of await tableKeys(tx, `${parsed.tablePrefix}locks`, "thread_id")) {
    if (scopedChatStateKey(key, parsed.agent, parsed.channels)) plan.locks += 1
  }
  plan.unmatched = [...unmatched].sort()
  return plan
}

async function applyMigration(tx: SqliteAgentStateExtensionExecutor, prefix: string, moves: readonly StateKeyMove[]): Promise<void> {
  for (const move of moves) {
    const table = `${prefix}${move.table}`
    if (move.table === "subscriptions") {
      await tx.execute(`INSERT OR IGNORE INTO ${table} (thread_id) VALUES (?)`, [move.to])
      await tx.execute(`DELETE FROM ${table} WHERE thread_id = ?`, [move.from])
      continue
    }
    await tx.execute(`UPDATE ${table} SET ${keyColumns[move.table]} = ? WHERE ${keyColumns[move.table]} = ?`, [move.to, move.from])
  }
}

function report(plan: StateMigrationPlan, apply: boolean): string {
  const lines: string[] = []
  const line = (move: StateKeyMove) => `  ${move.table.padEnd(13)} ${move.from} -> ${move.to}`
  const keys = (count: number) => `${count} ${count === 1 ? "key" : "keys"}`
  lines.push(apply ? `Moved ${keys(plan.moves.length)} to their Channel scope.` : `${keys(plan.moves.length)} move to their Channel scope.`)
  lines.push(...plan.moves.map(line))
  if (plan.conflicts.length) {
    lines.push(`${keys(plan.conflicts.length)} already ${plan.conflicts.length === 1 ? "exists" : "exist"} in the Channel scope and ${plan.conflicts.length === 1 ? "stays" : "stay"}. To keep an old value, delete its scoped key and run the command again.`)
    lines.push(...plan.conflicts.map(line))
  }
  if (plan.unmatched.length) {
    lines.push(`${keys(plan.unmatched.length)} ${plan.unmatched.length === 1 ? "names no listed adapter and stays" : "name no listed adapter and stay"}:`)
    lines.push(...plan.unmatched.slice(0, 20).map(key => `  ${key}`))
    if (plan.unmatched.length > 20) lines.push(`  and ${plan.unmatched.length - 20} more`)
  }
  if (plan.locks) lines.push(`${plan.locks} ${plan.locks === 1 ? "lock stays" : "locks stay"}. Locks expire on their own.`)
  if (!apply) lines.push("Dry run: nothing changed. Run the command again with --apply to move the keys.")
  return `${lines.join("\n")}\n`
}

/**
 * `vitehub agent state migrate`: a one-time move of Chat State keys that an explicit `messages.state` wrote without a
 * scope. The provider default State reads them under `chat:<agent>:<channel>:`, so without the move it does not see
 * old threads, subscriptions, or transcripts.
 */
export async function runAgentStateCli(args: string[], context: AgentStateCliContext): Promise<number> {
  let parsed: ParsedArgs | "help"
  try {
    parsed = parse(args, context.env)
  }
  catch (error) {
    context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
    return 1
  }
  if (parsed === "help") {
    usage(context)
    return 0
  }
  const path = localFilePath(parsed.url)
  if (path && !existsSync(path)) {
    context.stderr.write(`${formatRuntimeDiagnosticError(agentDiagnostics.AGENT_STATE_MIGRATE_DATABASE_MISSING({ path }))}\n`)
    return 1
  }
  const state = createLibsqlAgentState({
    ...(context.env.VITEHUB_AGENT_STATE_AUTH_TOKEN ? { authToken: context.env.VITEHUB_AGENT_STATE_AUTH_TOKEN } : {}),
    tablePrefix: parsed.tablePrefix,
    url: parsed.url,
  })
  try {
    const options = parsed
    const plan = await state.extension("scope_migration").transaction(async (tx) => {
      const planned = await planMigration(tx, options)
      if (options.apply) await applyMigration(tx, options.tablePrefix, planned.moves)
      return planned
    })
    context.stdout.write(report(plan, options.apply))
    return 0
  }
  catch (error) {
    context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
    return 1
  }
  finally {
    await state.disconnect()
  }
}
