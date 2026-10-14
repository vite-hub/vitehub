import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff"

import {
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
} from "@vite-hub/internal/cli"

import { contentDevHeader, contentDevHeaderValue, contentDevRoute } from "./dev.ts"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { ContentRef } from "./collections.ts"
import type {
  ContentDevCollectionsResult,
  ContentDevDiffResult,
  ContentDevOperation,
  ContentDevPublishResult,
  ContentDevRequestBody,
  ContentDevRevisionsResult,
  ContentDevStatusResult,
} from "./dev.ts"

export type ContentCliContext = Pick<ViteHubCliContext, "cwd" | "env" | "rootDir"> & ViteHubCliStreams

export interface ContentCliOptions {
  /** Ask the user to confirm a publish. Defaults to a prompt on an interactive terminal; without one, `--yes` is required. */
  confirm?: (question: string) => Promise<boolean>
  fetch?: typeof fetch
}

type ContentCliOption = "cursor" | "dry-run" | "id" | "limit" | "message" | "ref" | "collection" | "yes"

interface ContentCliCommand {
  description: string
  name: ContentDevOperation
  options: readonly ContentCliOption[]
  /** Positional arguments in order. Optional ones end with `?`. */
  positionals: readonly string[]
}

interface ParsedContentArgs {
  collection?: string
  cursor?: string
  dryRun: boolean
  help: boolean
  id?: string
  ids?: string[]
  json: boolean
  limit?: number
  message?: string
  ref?: ContentRef
  timeout?: number
  url: string
  yes: boolean
}

interface ContentCliFailure {
  code?: string
  details?: unknown
  message: string
}

const contentDevEndpoint = {
  header: contentDevHeader,
  headerValue: contentDevHeaderValue,
  route: contentDevRoute,
}

const usageError = (message: string) => contentErrorDiagnostics.CONTENT_R0010({ message })
const contentDevTargetErrors = {
  invalidInlineTimeout: usageError,
  invalidTimeout: usageError,
  missingValue: usageError,
}

// Nuxt mounts Vite under `/_nuxt/`, so the Content dev endpoint is not reachable there.
const contentDevServerHint = "`vitehub content` needs a running Vite + Nitro Development Server of an app with server/content.ts. Nuxt, plain Vite, and deployed apps are not supported."

const contentCommands: readonly ContentCliCommand[] = [
  { description: "List document collections with their fields and document counts.", name: "collections", options: [], positionals: [] },
  { description: "Show whether each document is draft, published, changed, or deleted.", name: "status", options: [], positionals: ["collection?", "id?"] },
  { description: "Print a unified diff of one document from published to draft, frontmatter included.", name: "diff", options: [], positionals: ["collection", "id"] },
  { description: "List the revisions that saved, removed, restored, or published one document, newest first.", name: "revisions", options: ["ref", "limit", "cursor"], positionals: ["collection", "id"] },
  { description: "Publish the listed draft documents in one revision, pinned to the digests shown. Asks for confirmation unless --yes. A draft saved after the list fails the publish.", name: "publish", options: ["collection", "id", "message", "dry-run", "yes"], positionals: [] },
]

const optionUsage: Record<ContentCliOption, string> = {
  "collection": "[--collection <name>]",
  "cursor": "[--cursor <cursor>]",
  "dry-run": "[--dry-run]",
  "id": "[--id <id>...]",
  "limit": "[--limit <n>]",
  "message": "[--message <text>]",
  "ref": "[--ref draft|published]",
  "yes": "[--yes]",
}

const optionHelp: Record<ContentCliOption, string> = {
  "collection": "  --collection <name>  Publish one collection. Omit it to publish every collection.",
  "cursor": "  --cursor <cursor>    Continue after this cursor. `revisions` prints the next cursor.",
  "dry-run": "  --dry-run            List what would be published, with each draft digest, without publishing.",
  "id": "  --id <id>            Publish only this document of --collection. Repeatable.",
  "limit": "  --limit <n>          Show at most n revisions. Defaults to 20. Maximum 100.",
  "message": "  --message <text>     Revision message of the publish.",
  "ref": "  --ref <ref>          `draft` (default) lists saves, removes, and restores; `published` lists publishes.",
  "yes": "  --yes, -y            Publish without asking for confirmation.",
}

function commandUsage(command: ContentCliCommand): string {
  const positionals = command.positionals.map(name => name.endsWith("?") ? ` [${name.slice(0, -1)}]` : ` <${name}>`).join("")
  const options = command.options.map(option => ` ${optionUsage[option]}`).join("")
  return `vitehub content ${command.name}${positionals}${options} [--json] [--url <url>]`
}

function writeUsage(command: ContentCliCommand, stream: ViteHubCliStreams["stdout"]): void {
  stream.write([
    `Usage: ${commandUsage(command)}`,
    "",
    command.description,
    "The command calls the Content runtime of a running Vite + Nitro Development Server, so it reads and writes",
    "the same Workspace Store as the app. It does not reach a deployed app.",
    "",
    "Options:",
    ...command.options.map(option => optionHelp[option]),
    "  --json               Print JSON.",
    "  --url <url>          Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --timeout <ms>       Request timeout.",
    "  -h, --help           Show this help.",
    "",
  ].join("\n"))
}

function readOptionValue(args: readonly string[], index: number, name: string): { consumed: number, value: string } | undefined {
  const arg = args[index]!
  if (arg === `--${name}`) {
    const value = args[index + 1]
    if (value === undefined || value.startsWith("--")) throw usageError(`--${name} needs a value.`)
    return { consumed: 1, value }
  }
  if (arg.startsWith(`--${name}=`)) return { consumed: 0, value: arg.slice(name.length + 3) }
}

function parseLimit(value: string): number {
  const limit = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw usageError("--limit must be an integer from 1 to 100.")
  return limit
}

function parseArgs(command: ContentCliCommand, args: readonly string[], env: NodeJS.ProcessEnv): ParsedContentArgs {
  const parsed: ParsedContentArgs = { dryRun: false, help: false, json: false, url: resolveViteHubDevServerUrl(env), yes: false }
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
    if ((arg === "--yes" || arg === "-y") && command.options.includes("yes")) {
      parsed.yes = true
      continue
    }
    if (arg === "--dry-run" && command.options.includes("dry-run")) {
      parsed.dryRun = true
      continue
    }
    if (arg === "--") {
      positionals.push(...args.slice(index + 1))
      break
    }
    const targetOption = readViteHubDevTargetOption(args, index, parsed, contentDevTargetErrors)
    if (targetOption !== undefined) {
      index += targetOption
      continue
    }
    let matched = false
    for (const option of ["collection", "cursor", "id", "limit", "message", "ref"] as const) {
      if (!command.options.includes(option)) continue
      const read = readOptionValue(args, index, option)
      if (!read) continue
      if (!read.value) throw usageError(`--${option} needs a nonempty value.`)
      if (option === "id") (parsed.ids ??= []).push(read.value)
      else if (option === "limit") parsed.limit = parseLimit(read.value)
      else if (option === "ref") {
        if (read.value !== "draft" && read.value !== "published") throw usageError("--ref must be draft or published.")
        parsed.ref = read.value
      }
      else parsed[option] = read.value
      index += read.consumed
      matched = true
      break
    }
    if (matched) continue
    if (arg.startsWith("-")) throw usageError(`Unknown option: ${arg}.`)
    positionals.push(arg)
  }
  if (positionals.length > command.positionals.length) throw usageError(`Unexpected argument: ${positionals[command.positionals.length]}.`)
  command.positionals.forEach((name, index) => {
    const value = positionals[index]
    if (value === undefined) {
      if (!name.endsWith("?") && !parsed.help) throw usageError(`Missing ${name}.`)
      return
    }
    if (name.startsWith("collection")) parsed.collection = value
    else parsed.id = value
  })
  if (parsed.ids && parsed.collection === undefined) throw usageError("--id requires --collection.")
  return parsed
}

/** The request for a read command, or the dry run that plans a publish. */
function requestBody(command: ContentCliCommand, parsed: ParsedContentArgs): ContentDevRequestOptions {
  const body: ContentDevRequestOptions = {}
  if (parsed.collection !== undefined) body.collection = parsed.collection
  if (parsed.id !== undefined) body.id = parsed.id
  if (parsed.ids !== undefined) body.ids = parsed.ids
  if (parsed.ref !== undefined) body.ref = parsed.ref
  if (parsed.limit !== undefined) body.limit = parsed.limit
  if (parsed.cursor !== undefined) body.cursor = parsed.cursor
  if (command.name === "publish") body.dryRun = true
  return body
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

async function readFailure(response: Response): Promise<ContentCliFailure> {
  let text: string
  try { text = await response.text() }
  catch (error) { return { message: `Could not read the Content error response: ${error instanceof Error ? error.message : String(error)}` } }
  try {
    const body: unknown = JSON.parse(text)
    const error: unknown = isRecord(body) ? body.error : undefined
    if (isRecord(error) && String(error.message) === error.message) {
      const failure: ContentCliFailure = { message: error.message }
      if (String(error.code) === error.code) failure.code = error.code
      if (error.details !== undefined) failure.details = error.details
      return failure
    }
  }
  catch {
    // Guard rejections use plain text.
  }
  return { message: text || `Content Dev request failed with HTTP ${response.status}.` }
}

function writeFailure(parsed: Pick<ParsedContentArgs, "json">, context: ContentCliContext, failure: ContentCliFailure): number {
  if (parsed.json) context.stdout.write(`${JSON.stringify({ error: failure }, null, 2)}\n`)
  else context.stderr.write(`${failure.message}\n`)
  return 1
}

function withTimeout(timeout: number | undefined): Pick<RequestInit, "signal"> {
  return timeout ? { signal: AbortSignal.timeout(timeout) } : {}
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** Unified diff from `published` to `draft`. Empty when both sides are equal. */
export function contentDocumentDiff(result: Pick<ContentDevDiffResult, "draft" | "path" | "published">): string {
  if (result.published?.digest === result.draft?.digest) return ""
  return createTwoFilesPatch(
    result.published ? `published/${result.path}` : "/dev/null",
    result.draft ? `draft/${result.path}` : "/dev/null",
    result.published?.text ?? "",
    result.draft?.text ?? "",
    undefined,
    undefined,
    { context: 3, headerOptions: FILE_HEADERS_ONLY },
  )
}

function writeCollections(result: ContentDevCollectionsResult, context: ContentCliContext): void {
  if (!result.collections.length) {
    context.stderr.write("No document collections. Add defineContent({ workspace, collections }) to server/content.ts.\n")
    return
  }
  const lines: string[] = []
  for (const collection of result.collections) {
    const states = (["published", "changed", "draft", "deleted"] as const)
      .filter(state => collection.states[state])
      .map(state => `${collection.states[state]} ${state}`)
    lines.push(
      `${collection.name}  ${collection.path}`,
      `  Fields: ${collection.fields.length ? collection.fields.join(", ") : "none"}`,
      `  Documents: ${collection.documents}${states.length ? ` (${states.join(", ")})` : ""}`,
    )
  }
  context.stdout.write(`${lines.join("\n")}\n`)
}

function writeStatus(result: ContentDevStatusResult, context: ContentCliContext): void {
  if (!result.documents.length) {
    context.stderr.write("No documents.\n")
    return
  }
  const width = Math.max(...result.documents.map(document => document.state.length))
  context.stdout.write(`${result.documents.map(document => `${document.state.padEnd(width)}  ${document.collection}/${document.id}`).join("\n")}\n`)
}

function writeRevisions(result: ContentDevRevisionsResult, context: ContentCliContext): void {
  if (!result.revisions.length) context.stderr.write(`No ${result.ref} revisions of ${result.collection}/${result.id}.\n`)
  for (const revision of result.revisions) {
    const content: unknown = revision.metadata?.content
    const action: unknown = isRecord(content) ? content.action : undefined
    context.stdout.write(`${[revision.id, revision.createdAt, String(action) === action ? action : "", revision.message ?? ""].filter(Boolean).join("  ")}\n`)
  }
  if (result.cursor) context.stderr.write(`More revisions may exist. Next page: --cursor ${result.cursor}\n`)
}

const shortDigestLength = 12

function shortDigest(digest: string | null | undefined): string {
  return digest ? digest.slice(0, shortDigestLength) : "deleted"
}

/** One line per document. Dry runs show the draft digest that the publish pins. */
function changeLines(documents: ContentDevPublishResult["documents"]): string {
  return documents.map((document) => {
    const line = `  ${document.change.padEnd(6)}  ${document.collection}/${document.id}`
    return document.digest === undefined ? line : `${line}  ${shortDigest(document.digest)}`
  }).join("\n")
}

/** The documents of a `publish({ expect })` conflict, from `details.documents`. */
function changedDocuments(failure: ContentCliFailure): Array<{ actual: string | null, collection: string, expected: string | null, id: string }> {
  const details = isRecord(failure.details) ? failure.details : {}
  if (failure.code !== "WORKSPACE_CONFLICT" || details.ref !== "draft" || !Array.isArray(details.documents)) return []
  return details.documents.filter(isRecord).flatMap((document) => {
    const { actual, collection, expected, id } = document
    if (String(collection) !== collection || String(id) !== id) return []
    const digest = (value: unknown) => String(value) === value ? value : null
    return [{ actual: digest(actual), collection, expected: digest(expected), id }]
  })
}

function writePublishFailure(parsed: Pick<ParsedContentArgs, "json">, context: ContentCliContext, failure: ContentCliFailure): number {
  const changed = changedDocuments(failure)
  if (parsed.json || !changed.length) return writeFailure(parsed, context, failure)
  const lines = changed.map(({ actual, collection, expected, id }) =>
    `  ${collection}/${id}  ${actual === null ? "deleted on the draft" : `draft is now ${shortDigest(actual)}`} (you confirmed ${shortDigest(expected)})`)
  context.stderr.write([
    `Nothing was published. ${plural(changed.length, "draft")} changed after you confirmed:`,
    ...lines,
    "Review them with `vitehub content diff <collection> <id>`, then run the publish again.",
    "",
  ].join("\n"))
  return 1
}

async function defaultConfirm(question: string): Promise<boolean | undefined> {
  if (!process.stdin.isTTY) return
  const { createInterface } = await import("node:readline/promises")
  const readline = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(?:es)?$/i.test((await readline.question(question)).trim())
  }
  finally {
    readline.close()
  }
}

type ContentDevRequestOptions = Omit<ContentDevRequestBody, "operation">

interface ContentDevResults {
  collections: ContentDevCollectionsResult
  diff: ContentDevDiffResult
  publish: ContentDevPublishResult
  revisions: ContentDevRevisionsResult
  status: ContentDevStatusResult
}

/** One request to the dev endpoint, typed by the result that the Nitro handler returns for the operation. */
type ContentDevCall = <TOperation extends ContentDevOperation>(
  operation: TOperation,
  options: ContentDevRequestOptions,
) => Promise<{ failure: ContentCliFailure, result?: undefined } | { failure?: undefined, result: ContentDevResults[TOperation] }>

async function runPublish(
  command: ContentCliCommand,
  parsed: ParsedContentArgs,
  context: ContentCliContext,
  call: ContentDevCall,
  options: ContentCliOptions,
): Promise<number> {
  const plan = await call("publish", requestBody(command, parsed))
  if (plan.failure) return writeFailure(parsed, context, plan.failure)
  const pending = plan.result
  if (parsed.dryRun || !pending.documents.length) {
    if (parsed.json) context.stdout.write(`${JSON.stringify(pending, null, 2)}\n`)
    else if (!pending.documents.length) context.stderr.write("Nothing to publish: every selected document is published as drafted.\n")
    else context.stdout.write(`Would publish ${plural(pending.documents.length, "document")}:\n${changeLines(pending.documents)}\n`)
    return 0
  }
  if (!parsed.yes) {
    if (!parsed.json) context.stderr.write(`Publish ${plural(pending.documents.length, "document")}:\n${changeLines(pending.documents)}\n`)
    const confirmed = options.confirm ? await options.confirm("Publish? [y/N] ") : await defaultConfirm("Publish? [y/N] ")
    if (confirmed === undefined) {
      return writeFailure(parsed, context, { code: "CONTENT_PUBLISH_UNCONFIRMED", message: "Publishing needs confirmation. Pass --yes to publish without a prompt, or --dry-run to only list the changes." })
    }
    if (!confirmed) {
      return writeFailure(parsed, context, { code: "CONTENT_PUBLISH_CANCELLED", message: "Publish cancelled." })
    }
  }
  // Publish exactly the draft digests that were listed and confirmed. A draft saved since then fails the publish.
  const expect = pending.documents.map(({ collection, id, digest }) => ({ collection, id, digest: digest ?? null }))
  const published = await call("publish", { expect, ...(parsed.message === undefined ? {} : { message: parsed.message }) })
  if (published.failure) return writePublishFailure(parsed, context, published.failure)
  const result = published.result
  if (parsed.json) {
    context.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  if (!result.revision) {
    context.stderr.write("Nothing to publish: every selected document is published as drafted.\n")
    return 0
  }
  context.stdout.write(`Published ${plural(result.documents.length, "document")} in revision ${result.revision.id}:\n${changeLines(result.documents)}\n`)
  return 0
}

async function runContentCommand(command: ContentCliCommand, args: string[], context: ContentCliContext, options: ContentCliOptions): Promise<number> {
  let parsed: ParsedContentArgs
  try {
    parsed = parseArgs(command, args, context.env)
  }
  catch (error) {
    const terminator = args.indexOf("--")
    if (args.slice(0, terminator < 0 ? args.length : terminator).includes("--json")) {
      const failure: ContentCliFailure = { message: error instanceof Error ? error.message : String(error) }
      if (isRecord(error) && String(error.code) === error.code) failure.code = error.code
      if (isRecord(error) && error.details !== undefined) failure.details = error.details
      return writeFailure({ json: true }, context, failure)
    }
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
  const server = await discoverViteHubDevServer<{ message?: unknown, root?: unknown, runtime?: unknown }>({
    endpoint: contentDevEndpoint,
    fetch: fetchImpl,
    parseDiscovery: value => isRecord(value) ? value : {},
    rootDir: context.rootDir,
    ...withTimeout(parsed.timeout),
    serverUrl: parsed.url,
    stderr: parsed.json ? { write: (chunk) => { discoveryError += String(chunk); return true } } : context.stderr,
  })
  if (!server) {
    if (parsed.json) return writeFailure(parsed, context, { message: `${discoveryError.trim()} ${contentDevServerHint}` })
    context.stderr.write(`${contentDevServerHint}\n`)
    return 1
  }
  if (server.discovery.runtime !== "nitro") {
    return writeFailure(parsed, context, {
      code: "CONTENT_DEV_RUNTIME_UNAVAILABLE",
      message: String(server.discovery.message) === server.discovery.message
        ? server.discovery.message
        : "This Vite Development Server cannot reach the Content runtime.",
    })
  }
  const call: ContentDevCall = async <TOperation extends ContentDevOperation>(operation: TOperation, options: ContentDevRequestOptions) => {
    const body: ContentDevRequestBody = { ...options, operation }
    let response: Response
    try {
      response = await fetchViteHubDevEndpoint(fetchImpl, server.url, contentDevEndpoint, {
        body: JSON.stringify(body),
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
        ...withTimeout(parsed.timeout),
      })
    }
    catch (error) {
      return { failure: { message: `Content Dev request failed: ${error instanceof Error ? error.message : String(error)}` } }
    }
    if (!response.ok) return { failure: await readFailure(response) }
    const result: unknown = await response.json().catch(() => undefined)
    if (result === null || Object(result) !== result || Array.isArray(result)) return { failure: { message: "The Content Dev response is not valid JSON." } }
    // SAFETY: The Content dev handler of the same package answers each operation with its documented result type.
    return { result: result as ContentDevResults[TOperation] }
  }
  if (command.name === "publish") return await runPublish(command, parsed, context, call, options)
  if (command.name === "diff") {
    const { failure, result } = await call("diff", requestBody(command, parsed))
    if (failure) return writeFailure(parsed, context, failure)
    const patch = contentDocumentDiff(result)
    if (parsed.json) context.stdout.write(`${JSON.stringify({ ...result, diff: patch }, null, 2)}\n`)
    else if (!patch) context.stderr.write(`No changes: ${result.collection}/${result.id} is published as drafted.\n`)
    else context.stdout.write(patch)
    return 0
  }
  const response = command.name === "collections"
    ? await call("collections", {})
    : command.name === "status"
      ? await call("status", requestBody(command, parsed))
      : await call("revisions", requestBody(command, parsed))
  if (response.failure) return writeFailure(parsed, context, response.failure)
  if (parsed.json) context.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`)
  else if ("collections" in response.result) writeCollections(response.result, context)
  else if ("documents" in response.result) writeStatus(response.result, context)
  else writeRevisions(response.result, context)
  return 0
}

/**
 * Runs one `vitehub content` command against a running Vite + Nitro Development Server.
 * `args[0]` is the command name, for example `status` or `publish`.
 */
export async function runContentCli(args: string[], context: ContentCliContext, options: ContentCliOptions = {}): Promise<number> {
  const [name, ...rest] = args
  const command = contentCommands.find(entry => entry.name === name)
  if (!command) {
    context.stderr.write(`${name ? `Unknown content command: ${name}\n` : ""}Commands: ${contentCommands.map(entry => entry.name).join(", ")}\n`)
    return 1
  }
  return await runContentCommand(command, rest, context, options)
}

export function createContentCliContributor(options: ContentCliOptions = {}): ViteHubCliContributor {
  return {
    namespaces: [{
      description: "Inspect and publish Content document collections in a running Vite + Nitro Development Server.",
      features: contentCommands.map(command => ({
        description: command.description,
        name: command.name,
        run: async (args: string[], context: ViteHubCliContext) => await runContentCommand(command, args, context, options),
        usage: commandUsage(command),
      })),
      name: "content",
    }],
  }
}
