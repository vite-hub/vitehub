import { createInterface } from "node:readline/promises"

import * as v from "valibot"

import { readViteHubDevTargetOption } from "@vite-hub/internal/cli"
import { redactInspectionText } from "@vite-hub/internal/inspect"
import { callOperationFromCli } from "@vite-hub/internal/operations"

import { rateLimitErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { RateLimitPeekInspection, RateLimitResetInspection } from "./counters.ts"
import type { RateLimitWindow } from "./types.ts"

export type RateLimitCliContext = Pick<ViteHubCliContext, "cwd" | "env" | "fetch" | "rootDir"> & ViteHubCliStreams

export interface RateLimitCliOptions {
  /** Asks whether `reset` may delete a counter. Defaults to a prompt on a terminal, and refuses without one. */
  confirm?: (question: string) => boolean | Promise<boolean>
  fetch?: typeof fetch
}

interface RateLimitCommand {
  description: string
  name: "peek" | "reset"
}

interface ParsedRateLimitArgs {
  help: boolean
  yes: boolean
  json: boolean
  key?: string
  name?: string
  timeout?: number
  url?: string
}

const rateLimitDevTargetErrors = {
  invalidInlineTimeout: (message: string) => rateLimitErrorDiagnostics.RATE_LIMIT_R0041({ message }),
  invalidTimeout: (message: string) => rateLimitErrorDiagnostics.RATE_LIMIT_R0041({ message }),
  missingValue: (message: string) => rateLimitErrorDiagnostics.RATE_LIMIT_R0040({ message }),
}

const rateLimitCommands: readonly RateLimitCommand[] = [
  { description: "Show the counter of one key without consuming a token.", name: "peek" },
  { description: "Delete the counter of one key, where the provider supports it.", name: "reset" },
]

function commandUsage(command: RateLimitCommand): string {
  return `vitehub rate-limit ${command.name} <id> <key> [--json]${command.name === "reset" ? " [--yes]" : ""} [--url <url>]`
}

function writeUsage(command: RateLimitCommand, stream: ViteHubCliStreams["stdout"]): void {
  stream.write([
    `Usage: ${commandUsage(command)}`,
    "",
    command.description,
    "The command runs the rate-limit operation of the app: on the dev server of this project, or on a deployed app with --url.",
    "`<id>` is the stable ID of `requireRateLimit()`. `<key>` is the limited key, for example a client IP or user ID.",
    "",
    "Use -- before a key that starts with a dash.",
    "",
    "Options:",
    ...(command.name === "reset" ? ["  --yes, -y         Reset without asking. Without it, the command asks on a terminal and refuses elsewhere."] : []),
    "  --json            Print JSON.",
    "  --url <url>       Deployed app URL. Credentials come from VITEHUB_CONSOLE_AUTHORIZATION, VITEHUB_CONSOLE_COOKIE, or CF_ACCESS_*. Defaults to the dev server of this project.",
    "  --timeout <ms>    Request timeout.",
    "  -h, --help        Show this help.",
    "",
  ].join("\n"))
}

function parseArgs(args: readonly string[]): ParsedRateLimitArgs {
  const parsed: ParsedRateLimitArgs = { help: false, json: false, yes: false }
  let positionalOnly = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (!positionalOnly && arg === "--") { positionalOnly = true; continue }
    if (!positionalOnly && (arg === "-h" || arg === "--help")) {
      parsed.help = true
      continue
    }
    if (!positionalOnly && (arg === "--yes" || arg === "-y")) {
      parsed.yes = true
      continue
    }
    if (!positionalOnly && arg === "--json") {
      parsed.json = true
      continue
    }
    const targetOption = positionalOnly ? undefined : readViteHubDevTargetOption(args, index, parsed, rateLimitDevTargetErrors)
    if (targetOption !== undefined) {
      index += targetOption
      continue
    }
    if (!positionalOnly && arg.startsWith("-")) throw rateLimitErrorDiagnostics.RATE_LIMIT_R0040({ message: `Unknown option: ${arg}.` })
    if (parsed.name === undefined) {
      parsed.name = arg
      continue
    }
    if (parsed.key === undefined) {
      parsed.key = arg
      continue
    }
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0040({ message: `Unexpected argument: ${arg}.` })
  }
  if (!parsed.help && !parsed.name) throw rateLimitErrorDiagnostics.RATE_LIMIT_R0040({ message: "Missing Rate Limit ID." })
  if (!parsed.help && !parsed.key) throw rateLimitErrorDiagnostics.RATE_LIMIT_R0040({ message: "Missing Rate Limit key." })
  return parsed
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")).join("\n")
}

function scopeNotice(scope: string): string {
  return scope === "process"
    ? "Scope: process. The counter exists only in this server process."
    : `Scope: ${scope}.`
}

function formatPeek(result: RateLimitPeekInspection): string {
  const header = `Rate Limit ${result.name}, key ${result.key}\nProvider: ${result.provider}\n`
  if (result.status !== "known") return `${header}${result.status === "unused" ? "No counter" : "Counter unknown"}: ${result.reason}\n`
  return `${header}${scopeNotice(result.scope)}\n${table([
    ["LIMIT", "WINDOW", "USED", "REMAINING", "RESETS AT"],
    ...result.counters.map(counter => [
      String(counter.limit),
      counter.window,
      String(counter.used),
      String(counter.remaining),
      counter.resetAt === undefined ? "-" : new Date(counter.resetAt).toISOString(),
    ]),
  ])}\n`
}

function formatReset(result: RateLimitResetInspection): string {
  if (result.status !== "reset") return `Rate Limit ${result.name}, key ${result.key}\nProvider: ${result.provider}\nNot reset: ${result.reason}\n`
  return `Reset Rate Limit ${result.name} for key ${result.key}.\nProvider: ${result.provider}\n${scopeNotice(result.scope)}\n`
}

const windowSchema = v.custom<RateLimitWindow>(value => v.is(v.pipe(v.string(), v.regex(/^\d+(?:\.\d+)?(?:ms|s|m|h|d)$/)), value))
const finiteNumber = v.pipe(v.number(), v.finite())
const targetFields = { key: v.string(), name: v.string(), provider: v.picklist(["memory", "cloudflare"]) }
const scopeSchema = v.picklist(["global", "location", "process"])
const counterSchema = v.object({
  limit: finiteNumber, remaining: finiteNumber, resetAt: v.optional(v.pipe(finiteNumber, v.minValue(-8.64e15), v.maxValue(8.64e15))),
  used: finiteNumber, window: windowSchema, windowMs: finiteNumber,
})
const unavailableSchema = v.object({ ...targetFields, reason: v.string(), status: v.literal("unavailable") })
const unsupportedSchema = v.object({ ...targetFields, reason: v.string(), status: v.literal("unsupported") })
const peekSchema = v.variant("status", [
  v.object({ ...targetFields, counters: v.array(counterSchema), scope: scopeSchema, status: v.literal("known") }),
  v.object({ ...targetFields, reason: v.string(), status: v.literal("unused") }),
  unavailableSchema, unsupportedSchema,
])
const resetSchema = v.variant("status", [v.object({ ...targetFields, scope: scopeSchema, status: v.literal("reset") }), unavailableSchema, unsupportedSchema])
type RateLimitCliResult = { operation: "peek", value: RateLimitPeekInspection } | { operation: "reset", value: RateLimitResetInspection }

function parseInspection(operation: RateLimitCommand["name"], value: unknown): RateLimitCliResult | undefined {
  if (operation === "peek") {
    const parsed = v.safeParse(peekSchema, value)
    return parsed.success ? { operation, value: parsed.output } : undefined
  }
  const parsed = v.safeParse(resetSchema, value)
  return parsed.success ? { operation, value: parsed.output } : undefined
}

function writeFailure(parsed: Pick<ParsedRateLimitArgs, "json">, context: RateLimitCliContext, failure: { code?: string, fix?: string, message: string }): number {
  const message = redactInspectionText(failure.message)
  if (parsed.json) context.stdout.write(`${JSON.stringify({ error: { ...failure, message } }, null, 2)}\n`)
  else context.stderr.write(`${message}${failure.fix ? `\n${failure.fix}` : ""}\n`)
  return 1
}

async function askOnTerminal(question: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(es)?$/i.test((await terminal.question(question)).trim())
  }
  finally {
    terminal.close()
  }
}

async function runRateLimitCommand(
  command: RateLimitCommand,
  args: string[],
  context: RateLimitCliContext,
  options: RateLimitCliOptions,
): Promise<number> {
  let parsed: ParsedRateLimitArgs
  try {
    parsed = parseArgs(args)
  }
  catch (error) {
    const terminator = args.indexOf("--")
    if (args.slice(0, terminator < 0 ? args.length : terminator).includes("--json")) return writeFailure({ json: true }, context, { message: error instanceof Error ? error.message : String(error) })
    writeFailure({ json: false }, context, { message: error instanceof Error ? error.message : String(error) })
    writeUsage(command, context.stderr)
    return 1
  }
  if (parsed.help) {
    writeUsage(command, context.stdout)
    return 0
  }
  // A reset deletes the counter, which lets a limited client through again.
  if (command.name === "reset" && !parsed.yes) {
    const question = `Reset the Rate Limit ${parsed.name} for key ${redactInspectionText(parsed.key!)}? The next request starts a new window. [y/N] `
    const confirmed = options.confirm ? await options.confirm(question) : (process.stdin.isTTY && process.stderr.isTTY) ? await askOnTerminal(question) : false
    if (!confirmed) {
      return writeFailure(parsed, context, { code: "RATE_LIMIT_NOT_CONFIRMED", fix: "Run it again with --yes.", message: "rate-limit reset deletes a counter and was not confirmed." })
    }
  }
  const called = await callOperationFromCli({
    env: context.env,
    fetch: context.fetch ?? options.fetch ?? globalThis.fetch,
    rootDir: context.rootDir,
    ...(parsed.timeout ? { timeout: parsed.timeout } : {}),
    ...(parsed.url ? { url: parsed.url } : {}),
  }, `rate-limit.${command.name}`, { key: parsed.key!, name: parsed.name! })
  if (!called.ok) return writeFailure(parsed, context, { code: called.code, message: called.message, ...(called.fix ? { fix: called.fix } : {}) })
  const result = parseInspection(command.name, called.value)
  if (!result) return writeFailure(parsed, context, { message: "The rate-limit operation answered with an invalid result." })
  const output = result.operation === "peek" ? formatPeek(result.value) : formatReset(result.value)
  context.stdout.write(parsed.json ? `${JSON.stringify(result.value, null, 2)}\n` : output)
  // A counter that the provider cannot read or reset is a command failure, so scripts can check the exit code.
  return result.value.status === "unsupported" || result.value.status === "unavailable" ? 1 : 0
}

/**
 * Runs one `vitehub rate-limit` command through the `rate-limit.*` operations, on the dev server of this project or on a
 * deployed app with `--url`.
 * `args[0]` is the command name, `peek` or `reset`.
 */
export async function runRateLimitCli(args: string[], context: RateLimitCliContext, options: RateLimitCliOptions = {}): Promise<number> {
  const [name, ...rest] = args
  const command = rateLimitCommands.find(entry => entry.name === name)
  if (!command) {
    context.stderr.write(`${name ? `Unknown rate-limit command: ${redactInspectionText(name)}\n` : ""}Commands: ${rateLimitCommands.map(entry => entry.name).join(", ")}\n`)
    return 1
  }
  return await runRateLimitCommand(command, rest, context, options)
}

export function createRateLimitCliContributor(options: RateLimitCliOptions = {}): ViteHubCliContributor {
  return {
    namespaces: [{
      description: "Read and reset Rate Limit counters in the running app.",
      features: rateLimitCommands.map(command => ({
        description: command.description,
        name: command.name,
        run: async (args: string[], context: ViteHubCliContext) => await runRateLimitCommand(command, args, context, options),
        usage: commandUsage(command),
      })),
      name: "rate-limit",
    }],
  }
}
