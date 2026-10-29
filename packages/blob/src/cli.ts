import { randomUUID } from "node:crypto"
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"

import * as v from "valibot"

import { readViteHubDevTargetOption } from "@vite-hub/internal/cli"
import { callOperationFromCli } from "@vite-hub/internal/operations"

import {
  blobDevDefaultListLimit,
  blobDevMaximumListLimit,
  blobDevMaximumUploadBytes,
} from "./results.ts"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"
import { sanitizeMediaRecord } from "./media/records.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { BlobDevOperation } from "./results.ts"
import type { BlobDevDeleteResult, BlobDevGetResult, BlobDevHeadResult, BlobDevListResult, BlobDevMediaResult, BlobDevObject, BlobDevPutResult, BlobDevVariantsResult } from "./runtime/operations.ts"

export type BlobCliContext = Pick<ViteHubCliContext, "cwd" | "env" | "fetch" | "rootDir"> & ViteHubCliStreams

export interface BlobCliOptions {
  /** Asks whether `del` may delete a blob. Defaults to a prompt on a terminal, and refuses without one. */
  confirm?: (question: string) => boolean | Promise<boolean>
  fetch?: typeof fetch
}

type BlobCliOption = "content-type" | "cursor" | "limit" | "output" | "prefix"

interface BlobCommand {
  description: string
  file?: boolean
  name: BlobDevOperation
  options: readonly BlobCliOption[]
  pathname: boolean
}

interface ParsedBlobArgs {
  contentType?: string
  cursor?: string
  file?: string
  help: boolean
  json: boolean
  limit?: number
  output?: string
  pathname?: string
  prefix?: string
  store?: string
  timeout?: number
  url?: string
  yes: boolean
}

interface BlobCliFailure {
  code?: string
  fix?: string
  message: string
}

const blobDevTargetErrors = {
  invalidInlineTimeout: (message: string) => blobErrorDiagnostics.BLOB_R0029({ message }),
  invalidTimeout: (message: string) => blobErrorDiagnostics.BLOB_R0029({ message }),
  missingValue: (message: string) => blobErrorDiagnostics.BLOB_R0029({ message }),
}

const blobCommands: readonly BlobCommand[] = [
  { description: "List blobs of a Blob store, one page at a time.", name: "list", options: ["prefix", "limit", "cursor"], pathname: false },
  { description: "Show the metadata of one blob.", name: "head", options: [], pathname: true },
  { description: "Download one blob to a file, or to stdout without --output.", name: "get", options: ["output"], pathname: true },
  { description: "Upload one file as a blob.", file: true, name: "put", options: ["content-type"], pathname: true },
  { description: "Delete one blob.", name: "del", options: [], pathname: true },
  { description: "Show the media record of one blob: size, dimensions, hash, alt text, focal point, and crops.", name: "media", options: [], pathname: true },
  { description: "List the cached image variants of one blob and its crop replacements.", name: "variants", options: [], pathname: true },
]

const optionUsage: Record<BlobCliOption, string> = {
  "content-type": "[--content-type <type>]",
  "cursor": "[--cursor <cursor>]",
  "limit": "[--limit <n>]",
  "output": "[--output <file>]",
  "prefix": "[--prefix <prefix>]",
}

const optionHelp: Record<BlobCliOption, string> = {
  "content-type": "  --content-type <t>  Content type of the blob. Without it, the storage detects the type from the pathname.",
  "cursor": "  --cursor <cursor>   Read the page after this cursor. `list` prints the next cursor.",
  "limit": `  --limit <n>         Show at most n blobs. Defaults to ${blobDevDefaultListLimit}. Maximum ${blobDevMaximumListLimit}.`,
  "output": "  --output <file>     Write the blob to this file. Without it, the bytes go to stdout.",
  "prefix": "  --prefix <prefix>   Show only blobs whose pathname starts with this prefix.",
}

function commandUsage(command: BlobCommand): string {
  const pathname = command.pathname ? " <pathname>" : ""
  const file = command.file ? " <file>" : ""
  const options = command.options.map(option => ` ${optionUsage[option]}`).join("")
  return `vitehub blob ${command.name}${pathname}${file}${options} [--store <name>] [--json]${command.name === "del" ? " [--yes]" : ""} [--url <url>]`
}

function writeUsage(command: BlobCommand, stream: ViteHubCliStreams["stdout"]): void {
  stream.write([
    `Usage: ${commandUsage(command)}`,
    "",
    command.description,
    "The command calls the Blob runtime of a running Vite + Nitro Development Server.",
    ...(command.file ? [`The file path is relative to the current directory. The operation accepts files up to ${blobDevMaximumUploadBytes} bytes (8 MiB).`] : []),
    ...(command.name === "get" ? ["--json needs --output, because stdout carries the file bytes otherwise."] : []),
    "",
    "Options:",
    ...command.options.map(option => optionHelp[option]),
    "  --store <name>      Blob store. Defaults to `default`.",
    "  --json              Print JSON.",
    ...(command.name === "del" ? ["  --yes, -y           Delete without asking. Without it, the command asks on a terminal and refuses elsewhere."] : []),
    "  --url <url>         Deployed app URL. Credentials come from VITEHUB_CONSOLE_AUTHORIZATION, VITEHUB_CONSOLE_COOKIE, or CF_ACCESS_*. Defaults to the dev server of this project.",
    "  --timeout <ms>      Request timeout.",
    "  -h, --help          Show this help.",
    "",
  ].join("\n"))
}

function parsePositiveInteger(name: string, value: string): number {
  const number = Number(value)
  if (!value || !Number.isInteger(number) || number < 1) {
    throw blobErrorDiagnostics.BLOB_R0029({ message: `--${name} must be a positive integer.` })
  }
  return number
}

function readOptionValue(args: readonly string[], index: number, name: string): { consumed: number, value: string } | undefined {
  const arg = args[index]!
  if (arg === `--${name}`) {
    const value = args[index + 1]
    if (value === undefined || value.startsWith("--")) throw blobErrorDiagnostics.BLOB_R0029({ message: `--${name} needs a value.` })
    return { consumed: 1, value }
  }
  if (arg.startsWith(`--${name}=`)) return { consumed: 0, value: arg.slice(name.length + 3) }
}

function parseArgs(command: BlobCommand, args: readonly string[]): ParsedBlobArgs {
  const parsed: ParsedBlobArgs = { help: false, json: false, yes: false }
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
    if (command.name === "del" && (arg === "--yes" || arg === "-y")) {
      parsed.yes = true
      continue
    }
    if (arg === "--") {
      positionals.push(...args.slice(index + 1))
      break
    }
    const targetOption = readViteHubDevTargetOption(args, index, parsed, blobDevTargetErrors)
    if (targetOption !== undefined) {
      index += targetOption
      continue
    }
    const store = readOptionValue(args, index, "store")
    if (store) {
      if (!store.value.trim()) throw blobErrorDiagnostics.BLOB_R0029({ message: "--store needs a nonempty name." })
      parsed.store = store.value
      index += store.consumed
      continue
    }
    let matched = false
    for (const option of command.options) {
      const read = readOptionValue(args, index, option)
      if (!read) continue
      if (option === "limit") parsed.limit = parsePositiveInteger(option, read.value)
      else if (option === "content-type") parsed.contentType = read.value
      else parsed[option] = read.value
      index += read.consumed
      matched = true
      break
    }
    if (matched) continue
    if (arg.startsWith("-")) throw blobErrorDiagnostics.BLOB_R0029({ message: `Unknown option: ${arg}.` })
    positionals.push(arg)
  }
  const expected = (command.pathname ? 1 : 0) + (command.file ? 1 : 0)
  if (positionals.length > expected) throw blobErrorDiagnostics.BLOB_R0029({ message: `Unexpected argument: ${positionals[expected]}.` })
  if (command.pathname) parsed.pathname = positionals[0]
  if (command.file) parsed.file = positionals[1]
  if (parsed.help) return parsed
  if (command.pathname && !parsed.pathname) throw blobErrorDiagnostics.BLOB_R0029({ message: "Missing pathname." })
  if (command.file && !parsed.file) throw blobErrorDiagnostics.BLOB_R0029({ message: "Missing file." })
  if (parsed.limit !== undefined && parsed.limit > blobDevMaximumListLimit) {
    throw blobErrorDiagnostics.BLOB_R0029({ message: `--limit must be at most ${blobDevMaximumListLimit}.` })
  }
  if (parsed.output !== undefined && !parsed.output.trim()) throw blobErrorDiagnostics.BLOB_R0029({ message: "--output needs a nonempty path." })
  if (command.name === "get" && parsed.json && !parsed.output) {
    throw blobErrorDiagnostics.BLOB_R0029({ message: "--json needs --output, because stdout carries the file bytes otherwise." })
  }
  return parsed
}

/** Reads the upload file. The size check runs before the read, so a large file is not loaded. */
async function readUpload(path: string): Promise<{ data: string } | BlobCliFailure> {
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) return { message: `File not found: ${path}` }
  if (info.size > blobDevMaximumUploadBytes) {
    return {
      code: "BLOB_UPLOAD_TOO_LARGE",
      message: `The file is ${info.size} bytes. \`vitehub blob put\` accepts at most ${blobDevMaximumUploadBytes} bytes (8 MiB), because the file travels as base64 JSON.`,
    }
  }
  try {
    return { data: (await readFile(path)).toString("base64") }
  }
  catch (error) {
    return { message: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function formatSize(size: number | undefined): string {
  return size === undefined ? "-" : `${size} B`
}

function formatTable(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")).join("\n")
}

function formatMetadata(value: Record<string, unknown>): string | undefined {
  const entries = Object.entries(value)
  return entries.length ? entries.map(([name, entry]) => `${name}=${String(entry)}`).join(", ") : undefined
}

function formatObject(object: BlobDevObject, store: string): string {
  const rows: [string, string | undefined][] = [
    ["Pathname", object.pathname],
    ["Store", store],
    ["Size", formatSize(object.size)],
    ["Content type", object.contentType],
    ["ETag", object.httpEtag],
    ["Uploaded", object.uploadedAt],
    ["HTTP metadata", formatMetadata(object.httpMetadata)],
    ["Custom metadata", formatMetadata(object.customMetadata)],
  ]
  const present = rows.filter((row): row is [string, string] => row[1] !== undefined)
  return `${formatTable(present)}\n`
}

function formatMediaRecord({ record, store }: BlobDevMediaResult): string {
  const crops = Object.entries(record.crops ?? {}).map(([name, crop]) => [
    `${name} ${crop.aspect}`,
    crop.focal ? `focal ${crop.focal.x},${crop.focal.y}` : undefined,
    crop.replacement ? `replacement ${crop.replacement.pathname}${crop.replacement.width ? ` (${crop.replacement.width}x${crop.replacement.height})` : ""}` : undefined,
  ].filter(Boolean).join(", "))
  const rows: [string, string | undefined][] = [
    ["Pathname", record.pathname],
    ["Store", store],
    ["Size", formatSize(record.size)],
    ["Content type", record.contentType],
    ["Dimensions", record.width && record.height ? `${record.width}x${record.height}` : undefined],
    ["SHA-256", record.hash],
    ["ETag", record.etag],
    ["Alt", record.alt],
    ["Caption", record.caption],
    ["Focal point", record.focal ? `${record.focal.x},${record.focal.y}` : undefined],
    ["Color", record.color],
    ["URL", record.url],
    ["Updated", record.updatedAt],
    ...crops.map((crop, index): [string, string] => [index ? "" : "Crops", crop]),
  ]
  return `${formatTable(rows.filter((row): row is [string, string] => row[1] !== undefined))}\n`
}

type BlobCliResult =
  | { operation: "list", value: BlobDevListResult }
  | { operation: "head", value: BlobDevHeadResult }
  | { operation: "put", value: BlobDevPutResult }
  | { operation: "del", value: BlobDevDeleteResult }
  | { operation: "media", value: BlobDevMediaResult }
  | { operation: "variants", value: BlobDevVariantsResult }

const blobObjectSchema = v.object({
  contentType: v.optional(v.string()), customMetadata: v.record(v.string(), v.unknown()), httpEtag: v.optional(v.string()),
  httpMetadata: v.record(v.string(), v.unknown()), pathname: v.string(), size: v.optional(v.pipe(v.number(), v.finite())),
  uploadedAt: v.string(), urlAvailable: v.optional(v.literal(true)),
})
const resultSchemas = {
  list: v.object({ blobs: v.array(blobObjectSchema), cursor: v.optional(v.string()), hasMore: v.boolean(), limit: v.pipe(v.number(), v.finite()), prefix: v.string(), store: v.string(), stores: v.array(v.string()) }),
  head: v.object({ object: blobObjectSchema, store: v.string() }),
  put: v.object({ created: v.boolean(), object: blobObjectSchema, store: v.string() }),
  del: v.object({ deleted: v.boolean(), pathname: v.string(), store: v.string() }),
  media: v.object({ record: v.unknown(), store: v.string() }),
  variants: v.object({
    pathname: v.string(),
    store: v.string(),
    variants: v.array(v.object({ cachePathname: v.string(), contentType: v.optional(v.string()), key: v.optional(v.string()), size: v.number(), source: v.string() })),
  }),
}

function parseResult(operation: Exclude<BlobDevOperation, "get">, value: unknown): BlobCliResult | undefined {
  switch (operation) {
    case "list": { const parsed = v.safeParse(resultSchemas.list, value); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "head": { const parsed = v.safeParse(resultSchemas.head, value); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "put": { const parsed = v.safeParse(resultSchemas.put, value); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "del": { const parsed = v.safeParse(resultSchemas.del, value); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "media": {
      const parsed = v.safeParse(resultSchemas.media, value)
      const record = parsed.success ? sanitizeMediaRecord(parsed.output.record) : undefined
      return parsed.success && record ? { operation, value: { record: { ...record, ...(v.is(v.object({ url: v.string() }), parsed.output.record) ? { url: parsed.output.record.url } : {}) }, store: parsed.output.store } } : undefined
    }
    case "variants": { const parsed = v.safeParse(resultSchemas.variants, value); return parsed.success ? { operation, value: parsed.output } : undefined }
  }
}

function writeResult(result: BlobCliResult, context: BlobCliContext): void {
  switch (result.operation) {
    case "list": {
      const page = result.value
      if (page.blobs.length === 0 && page.cursor) context.stdout.write("No blobs on this page.\n")
      else if (page.blobs.length === 0) context.stdout.write(`No blobs${page.prefix ? ` with prefix ${page.prefix}` : ""} in store ${page.store}.\n`)
      else {
        context.stdout.write(`${formatTable([
          ["PATHNAME", "SIZE", "CONTENT TYPE", "UPLOADED"],
          ...page.blobs.map(object => [object.pathname, formatSize(object.size), object.contentType ?? "-", object.uploadedAt]),
        ])}\n`)
      }
      // The cursor hint goes to stderr, so stdout stays a plain table for scripts.
      if (page.cursor) context.stderr.write(`More blobs exist. Next page: --cursor ${page.cursor}\n`)
      else if (page.hasMore) context.stderr.write("More blobs exist, but the provider returned no cursor.\n")
      return
    }
    case "head": {
      const value = result.value
      context.stdout.write(formatObject(value.object, value.store))
      return
    }
    case "put": {
      const value = result.value
      const details = [formatSize(value.object.size), value.object.contentType].filter(Boolean).join(", ")
      context.stdout.write(`${value.created ? "Created" : "Replaced"} blob ${value.object.pathname} in store ${value.store} (${details}).\n`)
      return
    }
    case "media": {
      context.stdout.write(formatMediaRecord(result.value))
      return
    }
    case "variants": {
      const value = result.value
      if (!value.variants.length) {
        context.stdout.write(`No cached variants of ${value.pathname} in store ${value.store}.\n`)
        return
      }
      context.stdout.write(`${formatTable([
        ["KEY", "TYPE", "SIZE", "SOURCE"],
        ...value.variants.map(variant => [variant.key ?? variant.cachePathname, variant.contentType ?? "-", formatSize(variant.size), variant.source]),
      ])}\n`)
      return
    }
    case "del": {
      const value = result.value
      context.stdout.write(value.deleted
        ? `Deleted blob ${value.pathname} from store ${value.store}.\n`
        : `Blob ${value.pathname} did not exist in store ${value.store}. Nothing changed.\n`)
    }
  }
}

function writeFailure(parsed: Pick<ParsedBlobArgs, "json">, context: BlobCliContext, failure: BlobCliFailure): number {
  if (parsed.json) context.stdout.write(`${JSON.stringify({ error: failure }, null, 2)}\n`)
  else context.stderr.write(`${failure.message}${failure.fix ? `\n${failure.fix}` : ""}\n`)
  return 1
}

/** Writes the downloaded file to `--output` through a temporary file, or its bytes to stdout. */
async function writeDownload(file: BlobDevGetResult, parsed: ParsedBlobArgs, context: BlobCliContext): Promise<number> {
  const bytes = Uint8Array.from(atob(file.data), character => character.charCodeAt(0))
  if (!parsed.output) {
    context.stdout.write(bytes)
    return 0
  }
  const output = resolve(context.cwd, parsed.output)
  const temporaryOutput = `${output}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryOutput, bytes, { flag: "wx" })
    await rename(temporaryOutput, output)
  }
  catch (error) {
    await rm(temporaryOutput, { force: true }).catch(() => {})
    return writeFailure(parsed, context, { message: `Could not write ${output}: ${error instanceof Error ? error.message : String(error)}` })
  }
  const header = { contentType: file.contentType, pathname: file.pathname, size: file.size, store: file.store }
  if (parsed.json) context.stdout.write(`${JSON.stringify({ ...header, output }, null, 2)}\n`)
  else context.stdout.write(`Wrote blob ${header.pathname} from store ${header.store} to ${output} (${formatSize(header.size)}).\n`)
  return 0
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

async function runBlobCommand(command: BlobCommand, args: string[], context: BlobCliContext, options: BlobCliOptions): Promise<number> {
  let parsed: ParsedBlobArgs
  try {
    parsed = parseArgs(command, args)
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
  if (command.name === "del" && !parsed.yes) {
    const question = `Delete blob ${parsed.pathname} from Blob store ${parsed.store ?? "default"} at ${parsed.url ?? context.rootDir}? [y/N] `
    const confirmed = options.confirm ? await options.confirm(question) : (process.stdin.isTTY && process.stderr.isTTY) ? await askOnTerminal(question) : false
    if (!confirmed) return writeFailure(parsed, context, { code: "BLOB_NOT_CONFIRMED", fix: "Run it again with --yes.", message: "blob del deletes a blob and was not confirmed." })
  }
  let data: string | undefined
  if (command.file) {
    const upload = await readUpload(resolve(context.cwd, parsed.file!))
    if (!("data" in upload)) return writeFailure(parsed, context, upload)
    data = upload.data
  }
  const input: Record<string, unknown> = {}
  if (parsed.contentType !== undefined) input.contentType = parsed.contentType
  if (parsed.cursor !== undefined) input.cursor = parsed.cursor
  if (data !== undefined) input.data = data
  if (parsed.limit !== undefined) input.limit = parsed.limit
  if (parsed.pathname !== undefined) input.pathname = parsed.pathname
  if (parsed.prefix !== undefined) input.prefix = parsed.prefix
  if (parsed.store !== undefined) input.store = parsed.store
  // The command shows every object, also the ones that ViteHub keeps for itself. The Console hides them.
  if (command.name === "list") input.showVitehub = true
  const called = await callOperationFromCli({
    ...(command.name === "del" ? { confirmed: true } : {}),
    env: context.env,
    fetch: context.fetch ?? options.fetch ?? globalThis.fetch,
    rootDir: context.rootDir,
    ...(parsed.timeout ? { timeout: parsed.timeout } : {}),
    ...(parsed.url ? { url: parsed.url } : {}),
  }, `blob.${command.name}`, input)
  if (!called.ok) return writeFailure(parsed, context, { code: called.code, message: called.message, ...(called.fix ? { fix: called.fix } : {}) })
  if (command.name === "get") {
    const file = v.safeParse(v.object({ contentType: v.optional(v.string()), data: v.string(), pathname: v.string(), size: v.number(), store: v.string() }), called.value)
    return file.success ? await writeDownload(file.output, parsed, context) : writeFailure(parsed, context, { message: "The blob operation answered with an invalid file." })
  }
  const result = parseResult(command.name, called.value)
  if (!result) return writeFailure(parsed, context, { message: "The blob operation answered with an invalid result." })
  if (parsed.json) context.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`)
  else writeResult(result, context)
  return 0
}

/**
 * Runs one `vitehub blob` command: a `blob.*` operation on the dev server of this project, or on a deployed app with `--url`.
 * `args[0]` is the command name, for example `list` or `put`.
 */
export async function runBlobCli(args: string[], context: BlobCliContext, options: BlobCliOptions = {}): Promise<number> {
  const [name, ...rest] = args
  const command = blobCommands.find(entry => entry.name === name)
  if (!command) {
    context.stderr.write(`${name ? `Unknown blob command: ${name}\n` : ""}Commands: ${blobCommands.map(entry => entry.name).join(", ")}\n`)
    return 1
  }
  return await runBlobCommand(command, rest, context, options)
}

/** Returns the `blob` CLI namespace. */
export function createBlobCliNamespaces(options: BlobCliOptions = {}): NonNullable<ViteHubCliContributor["namespaces"]> {
  return [{
    description: "Read and write blobs of the Blob stores of the app, on the dev server or on a deployed app.",
    features: blobCommands.map(command => ({
      description: command.description,
      name: command.name,
      run: async (args: string[], context: ViteHubCliContext) => await runBlobCommand(command, args, context, options),
      usage: commandUsage(command),
    })),
    name: "blob",
  }]
}
