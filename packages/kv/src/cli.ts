import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import * as v from "valibot"

import {
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
} from "@vite-hub/internal/cli"

import { kvDevDefaultListLimit, kvDevHeader, kvDevHeaderValue, kvDevMaximumListLimit, kvDevRoute } from "./dev.ts"
import { kvErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { KVDevOperation, KVDevRequestBody } from "./dev.ts"
import type { KVDevDeleteResult, KVDevGetResult, KVDevHasResult, KVDevListResult, KVDevSetResult } from "./runtime/dev.ts"

export type KVCliContext = Pick<ViteHubCliContext, "cwd" | "env" | "rootDir"> & ViteHubCliStreams

export interface KVCliOptions {
  fetch?: typeof fetch
}

type KVCliOption = "cursor" | "json-value" | "limit" | "prefix" | "ttl"

interface KVCommand {
  description: string
  key: boolean
  name: KVDevOperation
  options: readonly KVCliOption[]
  value?: boolean
}

interface ParsedKVArgs {
  cursor?: string
  help: boolean
  json: boolean
  jsonValue: boolean
  key?: string
  limit?: number
  prefix?: string
  store?: string
  timeout?: number
  ttl?: number
  url: string
  value?: string
}

interface KVDevDiscovery {
  message?: unknown
  root?: unknown
  runtime?: unknown
}

interface KVCliFailure {
  code?: string
  message: string
}

const kvDevEndpoint = {
  header: kvDevHeader,
  headerValue: kvDevHeaderValue,
  route: kvDevRoute,
}

const kvDevTargetErrors = {
  invalidInlineTimeout: (message: string) => kvErrorDiagnostics.KV_R0019({ message }),
  invalidTimeout: (message: string) => kvErrorDiagnostics.KV_R0019({ message }),
  missingValue: (message: string) => kvErrorDiagnostics.KV_R0019({ message }),
}

// Nuxt mounts Vite under `/_nuxt/`, so the KV dev endpoint is not reachable there.
const kvDevServerHint = "`vitehub kv` needs a running Vite + Nitro Development Server with `kv` enabled. Nuxt and plain Vite are not supported."

const kvCommands: readonly KVCommand[] = [
  { description: "List keys of a KV store, one page at a time.", key: false, name: "list", options: ["prefix", "limit", "cursor"] },
  { description: "Print the value of one key.", key: true, name: "get", options: [] },
  { description: "Check if a key exists. The exit code is 0 when it exists and 1 when it does not.", key: true, name: "has", options: [] },
  { description: "Write the value of one key.", key: true, name: "set", options: ["ttl", "json-value"], value: true },
  { description: "Delete one key.", key: true, name: "del", options: [] },
]

const optionUsage: Record<KVCliOption, string> = {
  "cursor": "[--cursor <cursor>]",
  "json-value": "[--json-value]",
  "limit": "[--limit <n>]",
  "prefix": "[--prefix <prefix>]",
  "ttl": "[--ttl <seconds>]",
}

const optionHelp: Record<KVCliOption, string> = {
  "cursor": "  --cursor <cursor>   Read the page after this cursor. `list` prints the next cursor.",
  "json-value": "  --json-value        Parse the value as JSON. Without it, the value is a string.",
  "limit": `  --limit <n>         Show at most n keys. Defaults to ${kvDevDefaultListLimit}. Maximum ${kvDevMaximumListLimit}.`,
  "prefix": "  --prefix <prefix>   Show only keys that start with this prefix.",
  "ttl": "  --ttl <seconds>     Expire the key after this time. Some drivers ignore TTL or raise it to a minimum.",
}

function commandUsage(command: KVCommand): string {
  const key = command.key ? " <key>" : ""
  const value = command.value ? " <value|@file>" : ""
  const options = command.options.map(option => ` ${optionUsage[option]}`).join("")
  return `vitehub kv ${command.name}${key}${value}${options} [--store <name>] [--json] [--url <url>]`
}

function writeUsage(command: KVCommand, stream: ViteHubCliStreams["stdout"]): void {
  stream.write([
    `Usage: ${commandUsage(command)}`,
    "",
    command.description,
    "The command calls the KV runtime of a running Vite + Nitro Development Server.",
    ...(command.value ? ["A value that starts with @ names a UTF-8 file. The path is relative to the current directory."] : []),
    "",
    "Options:",
    ...command.options.map(option => optionHelp[option]),
    "  --store <name>      KV store. Defaults to `default`.",
    "  --json              Print JSON.",
    "  --url <url>         Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --timeout <ms>      Request timeout.",
    "  -h, --help          Show this help.",
    "",
  ].join("\n"))
}

function parsePositiveInteger(name: string, value: string | undefined): number {
  const number = Number(value)
  if (!value || !Number.isInteger(number) || number < 1) {
    throw kvErrorDiagnostics.KV_R0019({ message: `--${name} must be a positive integer.` })
  }
  return number
}

function parseTTL(value: string): number {
  const ttl = Number(value)
  if (!value || !Number.isFinite(ttl) || ttl <= 0) throw kvErrorDiagnostics.KV_R0019({ message: "--ttl must be a positive number." })
  return ttl
}

function readOptionValue(args: readonly string[], index: number, name: string): { consumed: number, value: string } | undefined {
  const arg = args[index]!
  if (arg === `--${name}`) {
    const value = args[index + 1]
    if (value === undefined || value.startsWith("--")) throw kvErrorDiagnostics.KV_R0019({ message: `--${name} needs a value.` })
    return { consumed: 1, value }
  }
  if (arg.startsWith(`--${name}=`)) return { consumed: 0, value: arg.slice(name.length + 3) }
}

function parseArgs(command: KVCommand, args: readonly string[], env: NodeJS.ProcessEnv): ParsedKVArgs {
  const parsed: ParsedKVArgs = { help: false, json: false, jsonValue: false, url: resolveViteHubDevServerUrl(env) }
  const positionals: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") {
      parsed.help = true
      continue
    }
    if (arg === "--json") {
      parsed.json = true
      continue
    }
    if (arg === "--json-value" && command.options.includes("json-value")) {
      parsed.jsonValue = true
      continue
    }
    if (arg === "--") {
      positionals.push(...args.slice(index + 1))
      break
    }
    const targetOption = readViteHubDevTargetOption(args, index, parsed, kvDevTargetErrors)
    if (targetOption !== undefined) {
      index += targetOption
      continue
    }
    const store = readOptionValue(args, index, "store")
    if (store) {
      if (!store.value.trim()) throw kvErrorDiagnostics.KV_R0019({ message: "--store needs a nonempty name." })
      parsed.store = store.value
      index += store.consumed
      continue
    }
    let matched = false
    for (const option of ["cursor", "limit", "prefix", "ttl"] as const) {
      if (!command.options.includes(option)) continue
      const read = readOptionValue(args, index, option)
      if (!read) continue
      if (option === "cursor" && !read.value.trim()) throw kvErrorDiagnostics.KV_R0019({ message: "--cursor needs a nonempty value." })
      if (option === "ttl") parsed.ttl = parseTTL(read.value)
      else if (option === "limit") parsed.limit = parsePositiveInteger(option, read.value)
      else parsed[option] = read.value
      index += read.consumed
      matched = true
      break
    }
    if (matched) continue
    if (arg.startsWith("-")) throw kvErrorDiagnostics.KV_R0019({ message: `Unknown option: ${arg}.` })
    positionals.push(arg)
  }
  const expected = (command.key ? 1 : 0) + (command.value ? 1 : 0)
  if (positionals.length > expected) throw kvErrorDiagnostics.KV_R0019({ message: `Unexpected argument: ${positionals[expected]}.` })
  if (command.key) parsed.key = positionals[0]
  if (command.value) parsed.value = positionals[1]
  if (!parsed.help && command.key && parsed.key === undefined) throw kvErrorDiagnostics.KV_R0019({ message: "Missing key." })
  if (!parsed.help && command.value && parsed.value === undefined) throw kvErrorDiagnostics.KV_R0019({ message: "Missing value." })
  if (parsed.limit !== undefined && parsed.limit > kvDevMaximumListLimit) {
    throw kvErrorDiagnostics.KV_R0019({ message: `--limit must be at most ${kvDevMaximumListLimit}.` })
  }
  return parsed
}

function validateJSONNumbers(value: unknown): void {
  if (v.is(v.number(), value)) {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw kvErrorDiagnostics.KV_R0019({ message: "JSON numbers must be finite and cannot be negative zero." })
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw kvErrorDiagnostics.KV_R0019({ message: "JSON integers must be within the safe integer range. Use a string for larger integers." })
  }
  if (Array.isArray(value)) value.forEach(validateJSONNumbers)
  else if (v.is(v.record(v.string(), v.unknown()), value)) Object.values(value).forEach(validateJSONNumbers)
}

function normalizedDecimal(source: string): string {
  const negative = source.startsWith("-")
  const [mantissa = "", exponent = "0"] = source.replace(/^-/, "").split(/[eE]/)
  const [whole = "", fraction = ""] = mantissa.split(".")
  const digits = `${whole}${fraction}`.replace(/^0+/, "")
  const significant = digits.replace(/0+$/, "")
  const scale = BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - significant.length)
  return `${negative ? "-" : ""}${significant}e${scale}`
}

async function readValue(parsed: ParsedKVArgs, cwd: string): Promise<unknown> {
  const raw = parsed.value!
  const text = raw.startsWith("@") ? await readFile(resolve(cwd, raw.slice(1)), "utf8") : raw
  if (!parsed.jsonValue) return text
  try {
    const value: unknown = JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
      if (value === 0 && context?.source && /[1-9]/.test(context.source.split(/[eE]/, 1)[0]!)) throw kvErrorDiagnostics.KV_R0019({ message: "JSON numbers cannot underflow to zero. Use a string to preserve the supplied value." })
      if (v.is(v.number(), value)) validateJSONNumbers(value)
      if (context?.source && v.is(v.number(), value) && value !== 0
        && normalizedDecimal(context.source) !== normalizedDecimal(JSON.stringify(value))) {
        throw kvErrorDiagnostics.KV_R0019({ message: `${Math.abs(value) <= 2 ** -1022 ? "JSON subnormal numbers" : "JSON numbers"} cannot change magnitude when parsed. Use a string to preserve the supplied value.` })
      }
      return value
    })
    validateJSONNumbers(value)
    return value
  }
  catch (error) {
    throw kvErrorDiagnostics.KV_R0019({ message: `The value is not valid JSON: ${error instanceof Error ? error.message : String(error)}` })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !Array.isArray(value) && v.is(v.record(v.string(), v.unknown()), value)
}

function formatValue(result: KVDevGetResult): string | Uint8Array {
  if (result.encoding === "base64" && v.is(v.string(), result.value)) return Uint8Array.from(atob(result.value), character => character.charCodeAt(0))
  if (v.is(v.string(), result.value)) return result.value
  return `${JSON.stringify(result.value, null, 2)}\n`
}

type KVCommandResult =
  | { operation: "list", value: KVDevListResult }
  | { operation: "get", value: KVDevGetResult }
  | { operation: "has", value: KVDevHasResult }
  | { operation: "set", value: KVDevSetResult }
  | { operation: "del", value: KVDevDeleteResult }

const targetFields = { key: v.string(), store: v.string() }
const positiveNumber = v.pipe(v.number(), v.finite(), v.gtValue(0))
const resultSchemas = {
  list: v.object({ cursor: v.optional(v.string()), keys: v.array(v.string()), limit: v.pipe(positiveNumber, v.integer()), prefix: v.string(), store: v.string(), stores: v.array(v.string()) }),
  get: v.pipe(v.object({ ...targetFields, encoding: v.optional(v.literal("base64")), found: v.boolean(), type: v.optional(v.string()), value: v.optional(v.unknown()) }), v.check(result => !result.found || (result.type !== undefined && result.value !== undefined), "found KV values require type and value"), v.check(result => result.encoding !== "base64" || v.is(v.pipe(v.string(), v.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)), result.value))),
  has: v.object({ ...targetFields, exists: v.boolean() }),
  set: v.object({ ...targetFields, created: v.boolean(), notice: v.optional(v.string()), ttl: v.optional(positiveNumber), type: v.string() }),
  del: v.object({ ...targetFields, deleted: v.boolean() }),
}

function parseResult(operation: KVDevOperation, result: unknown): KVCommandResult | undefined {
  switch (operation) {
    case "list": { const parsed = v.safeParse(resultSchemas.list, result); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "get": { const parsed = v.safeParse(resultSchemas.get, result); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "has": { const parsed = v.safeParse(resultSchemas.has, result); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "set": { const parsed = v.safeParse(resultSchemas.set, result); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "del": { const parsed = v.safeParse(resultSchemas.del, result); return parsed.success ? { operation, value: parsed.output } : undefined }
  }
}

function writeResult(result: KVCommandResult, context: KVCliContext): number {
  switch (result.operation) {
    case "list": {
      const page = result.value
      if (page.keys.some(key => /[\r\n\u2028\u2029]/.test(key))) return writeFailure({ json: false }, context, { message: "The KV list contains line-breaking keys. Use --json to preserve the complete keys." })
      // Some drivers scan a fixed number of entries per page, so a page can be empty while more keys exist.
      if (page.keys.length === 0 && page.cursor) context.stderr.write("No keys on this page.\n")
      else if (page.keys.length === 0) context.stderr.write(`No keys${page.prefix ? ` with prefix ${page.prefix}` : ""} in store ${page.store}.\n`)
      else context.stdout.write(`${page.keys.join("\n")}\n`)
      // The cursor hint goes to stderr, so stdout stays a plain key list for scripts.
      if (page.cursor) context.stderr.write(`More keys exist. Next page: --cursor ${page.cursor}\n`)
      return 0
    }
    case "get": {
      const value = result.value
      if (!value.found) {
        context.stderr.write(`Key ${value.key} was not found in store ${value.store}.\n`)
        return 1
      }
      context.stdout.write(formatValue(value))
      return 0
    }
    case "has": {
      const value = result.value
      context.stdout.write(`Key ${value.key} ${value.exists ? "exists" : "does not exist"} in store ${value.store}.\n`)
      return value.exists ? 0 : 1
    }
    case "set": {
      const value = result.value
      context.stdout.write([
        `${value.created ? "Created" : "Updated"} key ${value.key} in store ${value.store} (${value.type}${value.ttl ? `, TTL ${value.ttl} s` : ""}).`,
        ...(value.notice ? [value.notice] : []),
        "",
      ].join("\n"))
      return 0
    }
    case "del": {
      const value = result.value
      context.stdout.write(value.deleted
        ? `Deleted key ${value.key} from store ${value.store}.\n`
        : `Key ${value.key} was not found in store ${value.store}. Deletion completed.\n`)
      return 0
    }
  }
}

function exitCode(operation: KVDevOperation, result: Record<string, unknown>): number {
  if (operation === "get") return result.found === true ? 0 : 1
  if (operation === "has") return result.exists === true ? 0 : 1
  return 0
}

async function readFailure(response: Response): Promise<KVCliFailure> {
  let text: string
  try { text = await response.text() }
  catch (error) { return { message: `Could not read the KV error response: ${error instanceof Error ? error.message : String(error)}` } }
  try {
    const body: unknown = JSON.parse(text)
    const parsed = v.safeParse(v.object({ error: v.object({ code: v.optional(v.string()), message: v.string() }) }), body)
    if (parsed.success) return parsed.output.error
  }
  catch {
    // Guard rejections use plain text.
  }
  return { message: text || `KV Dev request failed with HTTP ${response.status}.` }
}

function writeFailure(parsed: Pick<ParsedKVArgs, "json">, context: KVCliContext, failure: KVCliFailure): number {
  if (parsed.json) context.stdout.write(`${JSON.stringify({ error: failure }, null, 2)}\n`)
  else context.stderr.write(`${failure.message}\n`)
  return 1
}

function withTimeout(timeout: number | undefined): Pick<RequestInit, "signal"> {
  return timeout ? { signal: AbortSignal.timeout(timeout) } : {}
}

async function runKVCommand(command: KVCommand, args: string[], context: KVCliContext, options: KVCliOptions): Promise<number> {
  let parsed: ParsedKVArgs
  let value: unknown
  try {
    parsed = parseArgs(command, args, context.env)
    if (command.value && !parsed.help) value = await readValue(parsed, context.cwd)
  }
  catch (error) {
    const terminator = args.indexOf("--")
    if (args.slice(0, terminator < 0 ? args.length : terminator).includes("--json")) return writeFailure({ json: true }, context, { message: error instanceof Error ? error.message : String(error) })
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    writeUsage(command, context.stderr)
    return 1
  }
  if (parsed.help) {
    writeUsage(command, context.stdout)
    return 0
  }
  const fetchImpl = options.fetch ?? globalThis.fetch
  let discoveryError = ""
  const server = await discoverViteHubDevServer<KVDevDiscovery>({
    endpoint: kvDevEndpoint,
    fetch: fetchImpl,
    parseDiscovery: (value) => {
      const parsed = v.safeParse(v.object({ message: v.optional(v.string()), root: v.optional(v.string()), runtime: v.optional(v.string()) }), value)
      return parsed.success ? parsed.output : {}
    },
    rootDir: context.rootDir,
    ...withTimeout(parsed.timeout),
    serverUrl: parsed.url,
    stderr: parsed.json ? { write: (chunk) => { discoveryError += chunk; return true } } : context.stderr,
  })
  if (!server) {
    if (parsed.json) return writeFailure(parsed, context, { message: `${discoveryError.trim()} ${kvDevServerHint}` })
    context.stderr.write(`${kvDevServerHint}\n`)
    return 1
  }
  if (server.discovery.runtime !== "nitro") {
    return writeFailure(parsed, context, {
      code: "KV_DEV_RUNTIME_UNAVAILABLE",
      message: v.is(v.string(), server.discovery.message)
        ? server.discovery.message
        : "This Vite Development Server cannot reach the KV runtime.",
    })
  }
  const body: KVDevRequestBody = { operation: command.name }
  if (parsed.cursor !== undefined) body.cursor = parsed.cursor
  if (parsed.key !== undefined) body.key = parsed.key
  if (parsed.limit !== undefined) body.limit = parsed.limit
  if (parsed.prefix !== undefined) body.prefix = parsed.prefix
  if (parsed.store !== undefined) body.store = parsed.store
  if (parsed.ttl !== undefined) body.ttl = parsed.ttl
  if (command.value) body.value = value
  let response: Response
  try {
    response = await fetchViteHubDevEndpoint(fetchImpl, server.url, kvDevEndpoint, {
      body: JSON.stringify(body),
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      ...withTimeout(parsed.timeout),
    })
  }
  catch (error) {
    return writeFailure(parsed, context, { message: `KV Dev request failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (!response.ok) return writeFailure(parsed, context, await readFailure(response))
  const result: unknown = await response.json().catch(() => undefined)
  if (!isRecord(result)) return writeFailure(parsed, context, { message: "The KV Dev response is not valid JSON." })
  const commandResult = parseResult(command.name, result)
  if (!commandResult) return writeFailure(parsed, context, { message: "The KV Dev response has an invalid result shape." })
  if (!parsed.json) return writeResult(commandResult, context)
  context.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return exitCode(command.name, result)
}

/**
 * Runs one `vitehub kv` command against a running Vite + Nitro Development Server.
 * `args[0]` is the command name, for example `list` or `set`.
 */
export async function runKVCli(args: string[], context: KVCliContext, options: KVCliOptions = {}): Promise<number> {
  const [name, ...rest] = args
  const command = kvCommands.find(entry => entry.name === name)
  if (!command) {
    context.stderr.write(`${name ? `Unknown kv command: ${name}\n` : ""}Commands: ${kvCommands.map(entry => entry.name).join(", ")}\n`)
    return 1
  }
  return await runKVCommand(command, rest, context, options)
}

export function createKVCliContributor(options: KVCliOptions = {}): ViteHubCliContributor {
  return {
    namespaces: [{
      description: "Read and write keys of the KV stores in a running Vite + Nitro Development Server.",
      features: kvCommands.map(command => ({
        description: command.description,
        name: command.name,
        run: async (args: string[], context: ViteHubCliContext) => await runKVCommand(command, args, context, options),
        usage: commandUsage(command),
      })),
      name: "kv",
    }],
  }
}
