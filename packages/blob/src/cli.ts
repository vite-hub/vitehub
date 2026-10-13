import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { readFile, rename, rm, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { Readable, Transform, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { readViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"

import * as v from "valibot"

import {
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
} from "@vite-hub/internal/cli"

import {
  blobDevDefaultListLimit,
  blobDevFileHeader,
  blobDevHeader,
  blobDevHeaderValue,
  blobDevMaximumListLimit,
  blobDevMaximumUploadBytes,
  blobDevRoute,
  blobDevTokenNamespace,
  blobDevTokenServerHeader,
} from "./dev.ts"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { BlobDevFileHeader, BlobDevOperation, BlobDevRequestBody } from "./dev.ts"
import type { BlobDevDeleteResult, BlobDevHeadResult, BlobDevListResult, BlobDevObject, BlobDevPutResult } from "./runtime/dev.ts"

export type BlobCliContext = Pick<ViteHubCliContext, "cwd" | "env" | "rootDir"> & ViteHubCliStreams

function isCompatibleBlobDevServerRoot(rootDir: string, serverRoot: string): boolean {
  const resolvedRootDir = resolve(rootDir)
  const resolvedServerRoot = resolve(serverRoot)
  if (resolveViteHubProjectRoot(resolvedRootDir) !== resolveViteHubProjectRoot(resolvedServerRoot)) return false
  const nestedPath = relative(resolvedRootDir, resolvedServerRoot)
  return nestedPath === "" || (nestedPath !== ".." && !nestedPath.startsWith(`..${sep}`) && !isAbsolute(nestedPath))
}

export interface BlobCliOptions {
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
  url: string
}

interface BlobDevDiscovery {
  message?: unknown
  root?: unknown
  runtime?: unknown
  blobDevTokenServerId?: unknown
}

interface BlobCliFailure {
  code?: string
  message: string
}

const blobDevEndpoint = {
  header: blobDevHeader,
  headerValue: blobDevHeaderValue,
  route: blobDevRoute,
}

const blobDevTargetErrors = {
  invalidInlineTimeout: (message: string) => blobErrorDiagnostics.BLOB_R0029({ message }),
  invalidTimeout: (message: string) => blobErrorDiagnostics.BLOB_R0029({ message }),
  missingValue: (message: string) => blobErrorDiagnostics.BLOB_R0029({ message }),
}

// Nuxt mounts Vite under `/_nuxt/`, so the Blob dev endpoint is not reachable there.
const blobDevServerHint = "`vitehub blob` needs a running Vite + Nitro Development Server with `blob` enabled. Nuxt and plain Vite are not supported."

const blobCommands: readonly BlobCommand[] = [
  { description: "List blobs of a Blob store, one page at a time.", name: "list", options: ["prefix", "limit", "cursor"], pathname: false },
  { description: "Show the metadata of one blob.", name: "head", options: [], pathname: true },
  { description: "Download one blob to a file, or to stdout without --output.", name: "get", options: ["output"], pathname: true },
  { description: "Upload one file as a blob.", file: true, name: "put", options: ["content-type"], pathname: true },
  { description: "Delete one blob.", name: "del", options: [], pathname: true },
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
  return `vitehub blob ${command.name}${pathname}${file}${options} [--store <name>] [--json] [--url <url>]`
}

function writeUsage(command: BlobCommand, stream: ViteHubCliStreams["stdout"]): void {
  stream.write([
    `Usage: ${commandUsage(command)}`,
    "",
    command.description,
    "The command calls the Blob runtime of a running Vite + Nitro Development Server.",
    ...(command.file ? [`The file path is relative to the current directory. The dev endpoint accepts files up to ${blobDevMaximumUploadBytes} bytes (8 MiB).`] : []),
    ...(command.name === "get" ? ["--json needs --output, because stdout carries the file bytes otherwise."] : []),
    "",
    "Options:",
    ...command.options.map(option => optionHelp[option]),
    "  --store <name>      Blob store. Defaults to `default`.",
    "  --json              Print JSON.",
    "  --url <url>         Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
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

function parseArgs(command: BlobCommand, args: readonly string[], env: NodeJS.ProcessEnv): ParsedBlobArgs {
  const parsed: ParsedBlobArgs = { help: false, json: false, url: resolveViteHubDevServerUrl(env) }
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
      code: "BLOB_DEV_UPLOAD_TOO_LARGE",
      message: `The file is ${info.size} bytes. \`vitehub blob put\` accepts at most ${blobDevMaximumUploadBytes} bytes (8 MiB), because the dev endpoint sends the file as base64 JSON.`,
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

type BlobCliResult =
  | { operation: "list", value: BlobDevListResult }
  | { operation: "head", value: BlobDevHeadResult }
  | { operation: "put", value: BlobDevPutResult }
  | { operation: "del", value: BlobDevDeleteResult }

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
}

function parseResult(operation: Exclude<BlobDevOperation, "get">, value: unknown): BlobCliResult | undefined {
  switch (operation) {
    case "list": { const parsed = v.safeParse(resultSchemas.list, value); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "head": { const parsed = v.safeParse(resultSchemas.head, value); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "put": { const parsed = v.safeParse(resultSchemas.put, value); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "del": { const parsed = v.safeParse(resultSchemas.del, value); return parsed.success ? { operation, value: parsed.output } : undefined }
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
    case "del": {
      const value = result.value
      context.stdout.write(value.deleted
        ? `Deleted blob ${value.pathname} from store ${value.store}.\n`
        : `Blob ${value.pathname} did not exist in store ${value.store}. Nothing changed.\n`)
    }
  }
}

async function readFailure(response: Response): Promise<BlobCliFailure> {
  let text: string
  try {
    text = await response.text()
  }
  catch (error) {
    return { message: `Could not read the Blob error response: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    const body: unknown = JSON.parse(text)
    const parsed = v.safeParse(v.object({ error: v.object({ code: v.optional(v.string()), message: v.string() }) }), body)
    if (parsed.success) return parsed.output.error
  }
  catch {
    // Guard rejections use plain text.
  }
  return { message: text || `Blob Dev request failed with HTTP ${response.status}.` }
}

function writeFailure(parsed: Pick<ParsedBlobArgs, "json">, context: BlobCliContext, failure: BlobCliFailure): number {
  if (parsed.json) context.stdout.write(`${JSON.stringify({ error: failure }, null, 2)}\n`)
  else context.stderr.write(`${failure.message}\n`)
  return 1
}

function withTimeout(timeout: number | undefined): Pick<RequestInit, "signal"> {
  return timeout ? { signal: AbortSignal.timeout(timeout) } : {}
}

const fileHeaderSchema = v.object({ pathname: v.string(), store: v.string(), contentType: v.optional(v.string()) })
function readFileHeader(response: Response, fallback: { pathname: string, store: string }, size: number): BlobDevFileHeader {
  const raw = response.headers.get(blobDevFileHeader)
  try {
    const parsed = v.safeParse(fileHeaderSchema, raw ? JSON.parse(decodeURIComponent(raw)) : undefined)
    if (parsed.success) return { ...parsed.output, size }
  }
  catch {
    // A missing or damaged header only removes the metadata. The bytes are still correct.
  }
  return { ...fallback, size }
}

async function writeDownload(response: Response, parsed: ParsedBlobArgs, context: BlobCliContext): Promise<number> {
  const output = parsed.output ? resolve(context.cwd, parsed.output) : undefined
  const temporaryOutput = output ? `${output}.${randomUUID()}.tmp` : undefined
  const destination = output
    ? createWriteStream(temporaryOutput!, { flags: "wx" })
    : context.stdout instanceof Writable
      ? context.stdout
      : new Writable({
          write(chunk: Uint8Array, _encoding, callback) {
            try {
              context.stdout.write(chunk)
              callback()
            }
            catch (error) {
              callback(error instanceof Error ? error : new Error(String(error)))
            }
          },
        })
  let size = 0
  const source = response.body ? Readable.fromWeb(response.body) : Readable.from([])
  let failureSource: "read" | "write" | undefined
  source.once("error", () => { failureSource ??= "read" })
  destination.once("error", () => { failureSource ??= "write" })
  const counter = new Transform({
    transform(chunk: Uint8Array, _encoding, callback) {
      size += chunk.byteLength
      callback(null, chunk)
    },
  })
  try {
    await pipeline(source, counter, destination, { end: Boolean(output) })
    if (output) await rename(temporaryOutput!, output)
  }
  catch (error) {
    if (temporaryOutput) await rm(temporaryOutput, { force: true }).catch(() => {})
    return writeFailure(parsed, context, { message: `${failureSource === "read" || !output ? "Could not read the Blob download" : `Could not write ${output}`}: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (!output) return 0
  const header = readFileHeader(response, { pathname: parsed.pathname!, store: parsed.store ?? "default" }, size)
  if (parsed.json) context.stdout.write(`${JSON.stringify({ ...header, output }, null, 2)}\n`)
  else context.stdout.write(`Wrote blob ${header.pathname} from store ${header.store} to ${output} (${formatSize(header.size)}).\n`)
  return 0
}

async function runBlobCommand(command: BlobCommand, args: string[], context: BlobCliContext, options: BlobCliOptions): Promise<number> {
  let parsed: ParsedBlobArgs
  try {
    parsed = parseArgs(command, args, context.env)
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
  let data: string | undefined
  if (command.file) {
    const upload = await readUpload(resolve(context.cwd, parsed.file!))
    if (!("data" in upload)) return writeFailure(parsed, context, upload)
    data = upload.data
  }
  const fetchImpl = options.fetch ?? globalThis.fetch
  let discoveryError = ""
  const server = await discoverViteHubDevServer<BlobDevDiscovery>({
    endpoint: blobDevEndpoint,
    fetch: fetchImpl,
    isCompatibleRoot: isCompatibleBlobDevServerRoot,
    rootDir: context.rootDir,
    serverUrl: parsed.url,
    ...withTimeout(parsed.timeout),
    stderr: parsed.json ? { write: (chunk) => { discoveryError += chunk; return true } } : context.stderr,
  })
  if (!server) {
    if (parsed.json) return writeFailure(parsed, context, { message: `${discoveryError.trim()} ${blobDevServerHint}` })
    context.stderr.write(`${blobDevServerHint}\n`)
    return 1
  }
  if (server.discovery.runtime !== "nitro") {
    return writeFailure(parsed, context, {
      code: "BLOB_DEV_RUNTIME_UNAVAILABLE",
      message: v.is(v.string(), server.discovery.message)
        ? server.discovery.message
        : "This Vite Development Server cannot reach the Blob runtime.",
    })
  }
  const serverId = v.is(v.string(), server.discovery.blobDevTokenServerId) ? server.discovery.blobDevTokenServerId : undefined
  let token: string | undefined
  try {
    const serverRoot = v.is(v.string(), server.discovery.root) ? server.discovery.root : resolveViteHubProjectRoot(context.rootDir)
    token = serverId ? await readViteHubDevToken(resolveViteHubProjectRoot(serverRoot), { namespace: blobDevTokenNamespace, serverId }) : undefined
  }
  catch (error) {
    return writeFailure(parsed, context, { message: `Could not read the private Blob Dev token: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (!serverId || !token) return writeFailure(parsed, context, { message: "No private Blob Dev token found. Restart the Compatible Vite Development Server." })
  const body: BlobDevRequestBody = { operation: command.name }
  if (parsed.contentType !== undefined) body.contentType = parsed.contentType
  if (parsed.cursor !== undefined) body.cursor = parsed.cursor
  if (data !== undefined) body.data = data
  if (parsed.limit !== undefined) body.limit = parsed.limit
  if (parsed.pathname !== undefined) body.pathname = parsed.pathname
  if (parsed.prefix !== undefined) body.prefix = parsed.prefix
  if (parsed.store !== undefined) body.store = parsed.store
  let response: Response
  try {
    response = await fetchViteHubDevEndpoint(fetchImpl, server.url, blobDevEndpoint, {
      body: JSON.stringify(body),
      headers: { accept: command.name === "get" ? "application/octet-stream" : "application/json", "content-type": "application/json", [viteHubDevTokenHeader]: token, [blobDevTokenServerHeader]: serverId },
      method: "POST",
      ...withTimeout(parsed.timeout),
    })
  }
  catch (error) {
    return writeFailure(parsed, context, { message: `Blob Dev request failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (!response.ok) return writeFailure(parsed, context, await readFailure(response))
  if (command.name === "get") return await writeDownload(response, parsed, context)
  const result = parseResult(command.name, await response.json().catch(() => undefined))
  if (!result) return writeFailure(parsed, context, { message: "The Blob Dev response is invalid." })
  if (parsed.json) context.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`)
  else writeResult(result, context)
  return 0
}

/**
 * Runs one `vitehub blob` command against a running Vite + Nitro Development Server.
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
    description: "Read and write blobs of the Blob stores in a running Vite + Nitro Development Server.",
    features: blobCommands.map(command => ({
      description: command.description,
      name: command.name,
      run: async (args: string[], context: ViteHubCliContext) => await runBlobCommand(command, args, context, options),
      usage: commandUsage(command),
    })),
    name: "blob",
  }]
}
