import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { formatRuntimeDiagnosticError } from "@vite-hub/runtime"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { chatStateAgentPrefix, chatStateChannelPrefix, chatStateScopedKey } from "./chat-state-scope.ts"

import type { InArgs } from "@libsql/client"

interface AgentStateCliContext {
  env: NodeJS.ProcessEnv
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface ParsedArgs {
  agent: string
  apply: boolean
  channels: Map<string, string>
  tablePrefix: string
  url: string
}

type StateTable = "cache" | "lists" | "queue" | "subscriptions"

type Execute = (sql: string, args?: InArgs) => Promise<Array<Record<string, unknown>>>

interface StateKeyMove {
  from: string
  table: StateTable
  to: string
}

interface StateMigrationPlan {
  conflicts: StateKeyMove[]
  locks: number
  moves: StateKeyMove[]
  unmatched: string[]
}

const usageText = "vitehub agent state migrate --agent <name> --channel <adapter>[=<channel>]... [--url <libsql-url>] [--table-prefix <prefix>] [--apply]"

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
        const listed = parsed.channels.get(adapter)
        if (listed !== undefined && listed !== channel) throw invalid(`--channel ${adapter} names the Channels ${listed} and ${channel}. Keys name only the adapter, so the command cannot tell them apart. Move them by hand.`)
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
  if (!/^[a-z][a-z0-9+.-]*:/i.test(parsed.url)) parsed.url = `file:${parsed.url}`
  return parsed
}

function localFilePath(url: string): string | undefined {
  if (!/^file:/i.test(url)) return
  const path = /^file:\/\//i.test(url) ? fileURLToPath(url) : decodeURIComponent(url.slice(5).split(/[?#]/, 1)[0]!)
  return path === ":memory:" ? undefined : resolve(path)
}

function keyAdapter(key: string, channels: ReadonlyMap<string, string>): string | undefined {
  if (key.startsWith("transcripts:user:")) {
    const identity = key.slice("transcripts:user:".length)
    const separator = identity.indexOf(":")
    if (separator < 0) return
    const adapter = identity.slice(0, separator)
    return channels.has(adapter) ? adapter : undefined
  }
  const concurrency = /^concurrency:\["([^"\\]*)"/.exec(key)
  if (concurrency) return channels.has(concurrency[1]!) ? concurrency[1] : undefined
  const [first = "", second] = key.split(":", 2)
  if (channels.has(first)) return first
  if (second !== undefined && !scopedKeyPrefixes.has(first) && channels.has(second)) return second
}

function scopedChatStateKey(key: string, agent: string, channels: ReadonlyMap<string, string>): string | undefined {
  const adapter = keyAdapter(key, channels)
  const channel = adapter === undefined ? undefined : channels.get(adapter)
  if (channel === undefined) return
  return chatStateScopedKey(key, chatStateAgentPrefix(agent), chatStateChannelPrefix(agent, channel))
}

async function tableKeys(execute: Execute, table: string, column: string): Promise<string[]> {
  return (await execute(`SELECT DISTINCT ${column} AS key FROM ${table}`)).map(row => String(row.key))
}

async function planMigration(execute: Execute, parsed: ParsedArgs): Promise<StateMigrationPlan> {
  const plan: StateMigrationPlan = { conflicts: [], locks: 0, moves: [], unmatched: [] }
  const unmatched = new Set<string>()
  const tables = new Set((await execute(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map(row => String(row.name)))
  if (!["cache", "lists", "queue", "subscriptions"].some(table => tables.has(`${parsed.tablePrefix}${table}`))) {
    throw agentDiagnostics.AGENT_STATE_MIGRATE_ARGUMENT_INVALID({ reason: `The database has no Agent State tables with the prefix ${parsed.tablePrefix}. Check --url and --table-prefix.` })
  }
  for (const table of ["cache", "lists", "queue", "subscriptions"] as const) {
    if (!tables.has(`${parsed.tablePrefix}${table}`)) continue
    const keys = await tableKeys(execute, `${parsed.tablePrefix}${table}`, keyColumns[table])
    const existing = new Set(keys)
    for (const key of keys) {
      if (key.startsWith(chatStateAgentPrefix(parsed.agent)) || key.startsWith("webhook:")) continue
      const to = scopedChatStateKey(key, parsed.agent, parsed.channels)
      if (!to) {
        unmatched.add(key)
        continue
      }
      const conflict = (table === "cache" || table === "lists") && existing.has(to)
      plan[conflict ? "conflicts" : "moves"].push({ from: key, table, to })
    }
  }
  if (tables.has(`${parsed.tablePrefix}locks`)) {
    for (const key of await tableKeys(execute, `${parsed.tablePrefix}locks`, "thread_id")) {
      if (scopedChatStateKey(key, parsed.agent, parsed.channels)) plan.locks += 1
    }
  }
  plan.unmatched = [...unmatched].sort()
  return plan
}

async function applyMigration(execute: Execute, prefix: string, moves: readonly StateKeyMove[]): Promise<void> {
  for (const move of moves) {
    const table = `${prefix}${move.table}`
    if (move.table === "subscriptions") {
      await execute(`INSERT OR IGNORE INTO ${table} (thread_id) VALUES (?)`, [move.to])
      await execute(`DELETE FROM ${table} WHERE thread_id = ?`, [move.from])
      continue
    }
    await execute(`UPDATE ${table} SET ${keyColumns[move.table]} = ? WHERE ${keyColumns[move.table]} = ?`, [move.to, move.from])
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
  const { createClient } = await import("@libsql/client")
  const client = createClient({
    ...(context.env.VITEHUB_AGENT_STATE_AUTH_TOKEN ? { authToken: context.env.VITEHUB_AGENT_STATE_AUTH_TOKEN } : {}),
    url: parsed.url,
  })
  const options = parsed
  const tx = await client.transaction(options.apply ? "write" : "read")
  try {
    const execute: Execute = async (sql, args = []) => (await tx.execute({ args, sql })).rows
    const plan = await planMigration(execute, options)
    if (options.apply) await applyMigration(execute, options.tablePrefix, plan.moves)
    await tx.commit()
    context.stdout.write(report(plan, options.apply))
    return 0
  }
  catch (error) {
    if (!tx.closed) await tx.rollback()
    context.stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
    return 1
  }
  finally {
    tx.close()
    client.close()
  }
}
