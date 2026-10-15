import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff"

import {
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
} from "@vite-hub/internal/cli"

import { contentDevHeader, contentDevHeaderValue, contentDevRoute } from "./dev.ts"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { renderContentSitemap } from "./sitemap.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { ContentDocumentStatus, ContentRef } from "./collections.ts"
import type { ContentFieldIssue } from "./documents.ts"
import type { ContentSchedule, ContentScheduleStatus } from "./schedules.ts"
import type {
  ContentDevCollectionsResult,
  ContentDevDiffResult,
  ContentDevListResult,
  ContentDevOperation,
  ContentDevPublishResult,
  ContentDevRequestBody,
  ContentDevRevisionsResult,
  ContentDevSaveResult,
  ContentDevSchedulesResult,
  ContentDevShowResult,
  ContentDevSitemapResult,
  ContentDevStatusResult,
  ContentDevUnscheduleResult,
} from "./dev.ts"

export type ContentCliContext = Pick<ViteHubCliContext, "cwd" | "env" | "rootDir"> & ViteHubCliStreams

export interface ContentCliOptions {
  /** Ask the user to confirm a publish or schedule. Defaults to a prompt on an interactive terminal; without one, `--yes` is required. */
  confirm?: (question: string) => Promise<boolean>
  /**
   * Open a file in an editor and resolve when the user closes it. Defaults to `$VISUAL` or `$EDITOR` (else `vi`) on an
   * interactive terminal; without one, `edit` needs `--file`.
   */
  editor?: (file: string) => Promise<void>
  fetch?: typeof fetch
}

type ContentCliOption =
  | "at" | "collection" | "cursor" | "dry-run" | "file" | "id" | "if-digest" | "limit" | "message" | "override-lease"
  | "ref" | "search" | "site" | "status" | "xml" | "yes"

type ContentCliCommandName =
  | "collections" | "list" | "show" | "status" | "diff" | "revisions" | "edit"
  | "publish" | "schedule" | "scheduled" | "unschedule" | "sitemap"

interface ContentCliCommand {
  description: string
  name: ContentCliCommandName
  options: readonly ContentCliOption[]
  /** Positional arguments in order. Optional ones end with `?`. */
  positionals: readonly string[]
}

interface ParsedContentArgs {
  at?: string
  collection?: string
  cursor?: string
  dryRun: boolean
  file?: string
  help: boolean
  id?: string
  ids?: string[]
  ifDigest?: string
  json: boolean
  limit?: number
  message?: string
  overrideLease: boolean
  ref?: ContentRef
  schedule?: string
  search?: string
  site?: string
  status?: ContentScheduleStatus
  timeout?: number
  url: string
  xml: boolean
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
  { description: "List collections and singletons with their fields and document counts.", name: "collections", options: [], positionals: [] },
  { description: "List the documents of a collection with their state, title, and field issues. Reads the draft unless --ref published.", name: "list", options: ["ref", "search", "limit", "cursor"], positionals: ["collection"] },
  { description: "Print the stored file of one document, frontmatter included, and its field issues. Omit the id for a singleton.", name: "show", options: ["ref"], positionals: ["collection", "id?"] },
  { description: "Show whether each document is draft, published, changed, or deleted, with field issues and schedules.", name: "status", options: [], positionals: ["collection?", "id?"] },
  { description: "Print a unified diff of one document from published to draft, frontmatter included. Omit the id for a singleton.", name: "diff", options: [], positionals: ["collection", "id?"] },
  { description: "List the revisions that saved, removed, restored, or published one document, newest first.", name: "revisions", options: ["ref", "limit", "cursor"], positionals: ["collection", "id?"] },
  { description: "Edit the draft of one document in $EDITOR, or save it from --file. Fails while someone else holds the edit lease, unless --override-lease.", name: "edit", options: ["file", "if-digest", "message", "override-lease"], positionals: ["collection", "id?"] },
  { description: "Publish the listed draft documents in one revision, pinned to the digests shown. Asks for confirmation unless --yes. A draft saved after the list fails the publish.", name: "publish", options: ["collection", "id", "message", "dry-run", "yes"], positionals: [] },
  { description: "Publish the listed draft documents at a later time, pinned to the digests shown. A Schedule Definition that calls content.publishDue() runs it.", name: "schedule", options: ["at", "collection", "id", "message", "dry-run", "yes"], positionals: [] },
  { description: "List pending, overdue, and failed schedules, earliest first.", name: "scheduled", options: ["status"], positionals: ["collection?", "id?"] },
  { description: "Cancel a pending schedule, or dismiss a failed one.", name: "unschedule", options: [], positionals: ["schedule"] },
  { description: "Print the sitemap URLs of published documents of collections with a url.", name: "sitemap", options: ["site", "xml"], positionals: [] },
]

const optionUsage: Record<ContentCliOption, string> = {
  "at": "--at <time>",
  "collection": "[--collection <name>]",
  "cursor": "[--cursor <cursor>]",
  "dry-run": "[--dry-run]",
  "file": "[--file <path>|-]",
  "id": "[--id <id>...]",
  "if-digest": "[--if-digest <digest>]",
  "limit": "[--limit <n>]",
  "message": "[--message <text>]",
  "override-lease": "[--override-lease]",
  "ref": "[--ref draft|published]",
  "search": "[--search <text>]",
  "site": "[--site <url>]",
  "status": "[--status pending|overdue|failed]",
  "xml": "[--xml]",
  "yes": "[--yes]",
}

const optionHelp: Record<ContentCliOption, string> = {
  "at": "  --at <time>          When to publish: an ISO timestamp with a time zone, such as 2026-10-20T09:00:00+02:00.",
  "collection": "  --collection <name>  Select one collection. Omit it to select every collection.",
  "cursor": "  --cursor <cursor>    Continue after this cursor. The command prints the next cursor.",
  "dry-run": "  --dry-run            List the changes, with each draft digest and field issue count, and change nothing.",
  "file": "  --file <path>        Save this file as the draft instead of opening an editor. `-` reads standard input.",
  "id": "  --id <id>            Select only this document of --collection. Repeatable.",
  "if-digest": "  --if-digest <digest> Save only if the draft still has this digest, as `show --json` prints it.",
  "limit": "  --limit <n>          Show at most n entries. Defaults to 20 for revisions and 50 for list. Maximum 100.",
  "message": "  --message <text>     Revision message.",
  "override-lease": "  --override-lease     Save even while another session holds the edit lease of the document.",
  "ref": "  --ref <ref>          `draft` (default) or `published`. For revisions, `draft` lists saves and `published` publishes.",
  "search": "  --search <text>      Only documents whose search fields contain the text.",
  "site": "  --site <url>         Public origin of the URLs. Defaults to defineContent({ seo: { site } }).",
  "status": "  --status <status>    Only pending, overdue, or failed schedules.",
  "xml": "  --xml                Print the sitemap XML that /sitemap.xml serves.",
  "yes": "  --yes, -y            Do it without asking for confirmation.",
}

const booleanOptions = { "dry-run": "dryRun", "override-lease": "overrideLease", "xml": "xml", "yes": "yes" } as const
const valueOptions = ["at", "collection", "cursor", "file", "id", "if-digest", "limit", "message", "ref", "search", "site", "status"] as const

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

function setValueOption(parsed: ParsedContentArgs, option: typeof valueOptions[number], value: string): void {
  switch (option) {
    case "id":
      (parsed.ids ??= []).push(value)
      return
    case "limit":
      parsed.limit = parseLimit(value)
      return
    case "ref":
      if (value !== "draft" && value !== "published") throw usageError("--ref must be draft or published.")
      parsed.ref = value
      return
    case "status":
      if (value !== "pending" && value !== "overdue" && value !== "failed") throw usageError("--status must be pending, overdue, or failed.")
      parsed.status = value
      return
    case "if-digest":
      parsed.ifDigest = value
      return
    default:
      parsed[option] = value
  }
}

function parseArgs(command: ContentCliCommand, args: readonly string[], env: NodeJS.ProcessEnv): ParsedContentArgs {
  const parsed: ParsedContentArgs = { dryRun: false, help: false, json: false, overrideLease: false, url: resolveViteHubDevServerUrl(env), xml: false, yes: false }
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
    if (arg === "-y" && command.options.includes("yes")) {
      parsed.yes = true
      continue
    }
    const flag = Object.entries(booleanOptions).find(([option]) => arg === `--${option}` && command.options.includes(option as ContentCliOption))
    if (flag) {
      parsed[flag[1]] = true
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
    for (const option of valueOptions) {
      if (!command.options.includes(option)) continue
      const read = readOptionValue(args, index, option)
      if (!read) continue
      if (!read.value) throw usageError(`--${option} needs a nonempty value.`)
      setValueOption(parsed, option, read.value)
      index += read.consumed
      matched = true
      break
    }
    if (matched) continue
    if (arg.startsWith("-") && arg !== "-") throw usageError(`Unknown option: ${arg}.`)
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
    else if (name === "schedule") parsed.schedule = value
    else parsed.id = value
  })
  if (parsed.ids && parsed.collection === undefined) throw usageError("--id requires --collection.")
  if (command.options.includes("at") && parsed.at === undefined && !parsed.help && !parsed.dryRun) throw usageError("Missing --at.")
  if (parsed.ifDigest !== undefined && parsed.file === undefined) throw usageError("--if-digest requires --file. An editor session pins the digest it opened.")
  return parsed
}

/** The request for a read command, or the dry run that plans a publish or schedule. */
function requestBody(parsed: ParsedContentArgs): ContentDevRequestOptions {
  const body: ContentDevRequestOptions = {}
  if (parsed.collection !== undefined) body.collection = parsed.collection
  if (parsed.id !== undefined) body.id = parsed.id
  if (parsed.ids !== undefined) body.ids = parsed.ids
  if (parsed.ref !== undefined) body.ref = parsed.ref
  if (parsed.limit !== undefined) body.limit = parsed.limit
  if (parsed.cursor !== undefined) body.cursor = parsed.cursor
  if (parsed.search !== undefined) body.search = parsed.search
  if (parsed.status !== undefined) body.status = parsed.status
  if (parsed.site !== undefined) body.site = parsed.site
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

/** `title: Required`, or `tags.0: Expected string`. A file that is not an object of fields has no field. */
function issueLines(issues: readonly ContentFieldIssue[], indent = "  "): string[] {
  return issues.map((issue) => {
    const where = [issue.field, ...issue.path].filter(segment => segment !== undefined).join(".")
    return `${indent}${where ? `${where}: ` : ""}${issue.message}`
  })
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
      `${collection.name}  ${collection.path}${collection.kind === "singleton" ? "  singleton" : ""}`,
      `  Fields: ${collection.fields.length ? collection.fields.join(", ") : "none"}`,
      `  Documents: ${collection.documents}${states.length ? ` (${states.join(", ")})` : ""}`,
    )
  }
  context.stdout.write(`${lines.join("\n")}\n`)
}

/** `2 issues; scheduled 2026-10-20T07:00:00.000Z`, or an empty string. */
function statusNotes(status: Pick<ContentDocumentStatus, "issues" | "schedule">): string {
  const notes: string[] = []
  if (status.issues) notes.push(plural(status.issues, "issue"))
  if (status.schedule) {
    notes.push(status.schedule.status === "failed"
      ? `schedule ${status.schedule.id} failed`
      : `${status.schedule.status === "overdue" ? "overdue since" : "scheduled"} ${status.schedule.at}`)
  }
  return notes.join("; ")
}

function writeStatus(result: ContentDevStatusResult, context: ContentCliContext): void {
  if (!result.documents.length) {
    context.stderr.write("No documents.\n")
    return
  }
  const width = Math.max(...result.documents.map(document => document.state.length))
  context.stdout.write(`${result.documents.map((document) => {
    const notes = statusNotes(document)
    return `${document.state.padEnd(width)}  ${document.collection}/${document.id}${notes ? `  (${notes})` : ""}`
  }).join("\n")}\n`)
}

function writeList(result: ContentDevListResult, context: ContentCliContext): void {
  if (!result.items.length) context.stderr.write(`No documents in ${result.collection} on ${result.ref}.\n`)
  else {
    const state = Math.max(...result.items.map(item => item.state.length))
    const id = Math.max(...result.items.map(item => item.id.length))
    context.stdout.write(`${result.items.map((item) => {
      const title = item.title === item.id ? "" : `  ${item.title}`
      return `${item.state.padEnd(state)}  ${item.id.padEnd(id)}${title}${item.issues ? `  (${plural(item.issues, "issue")})` : ""}`.trimEnd()
    }).join("\n")}\n`)
  }
  if (result.cursor) context.stderr.write(`${result.total} documents. Next page: --cursor ${result.cursor}\n`)
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

function writeSchedules(result: ContentDevSchedulesResult, context: ContentCliContext): void {
  if (!result.schedules.length) {
    context.stderr.write("No schedules.\n")
    return
  }
  const width = Math.max(...result.schedules.map(schedule => schedule.status.length))
  const lines = result.schedules.flatMap((schedule) => {
    const documents = schedule.expect.map(document => `${document.collection}/${document.id}`).join(", ")
    const line = `${schedule.status.padEnd(width)}  ${schedule.at}  ${schedule.id}  ${documents}`
    return schedule.failure ? [line, `  ${schedule.failure.code}: ${schedule.failure.message.replace(/^\[vitehub\]\s*/, "").split("\n")[0]}`] : [line]
  })
  context.stdout.write(`${lines.join("\n")}\n`)
}

function writeSitemap(result: ContentDevSitemapResult, parsed: Pick<ParsedContentArgs, "xml">, context: ContentCliContext): void {
  if (parsed.xml) {
    context.stdout.write(renderContentSitemap(result.entries))
    return
  }
  if (!result.entries.length) {
    context.stderr.write("No sitemap URLs. Add `url` to documents() and publish documents that are not noindex.\n")
    return
  }
  context.stdout.write(`${result.entries.map(entry => entry.lastmod ? `${entry.loc}  ${entry.lastmod}` : entry.loc).join("\n")}\n`)
}

const shortDigestLength = 12

function shortDigest(digest: string | null | undefined): string {
  return digest ? digest.slice(0, shortDigestLength) : "deleted"
}

/** One line per document. Dry runs show the draft digest that the publish pins, and field issues. */
function changeLines(documents: ContentDevPublishResult["documents"]): string {
  return documents.map((document) => {
    const line = `  ${document.change.padEnd(6)}  ${document.collection}/${document.id}`
    if (document.digest === undefined) return line
    return `${line}  ${shortDigest(document.digest)}${document.issues ? `  (${plural(document.issues, "issue")})` : ""}`
  }).join("\n")
}

/** The documents of a `publish({ expect })` or `schedule()` conflict, from `details.documents`. */
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

/** The documents of a `CONTENT_INVALID` from `publish()` or `schedule()`, from `details.documents`. */
function invalidDocuments(failure: ContentCliFailure): Array<{ collection: string, id: string, issues: ContentFieldIssue[] }> {
  const details = isRecord(failure.details) ? failure.details : {}
  if (failure.code !== "CONTENT_INVALID" || !Array.isArray(details.documents)) return []
  return details.documents.filter(isRecord).flatMap((document) => {
    const { collection, id, issues } = document
    if (String(collection) !== collection || String(id) !== id) return []
    // SAFETY: Content lists the ContentFieldIssue entries of each invalid document.
    return [{ collection, id, issues: Array.isArray(issues) ? issues as ContentFieldIssue[] : [] }]
  })
}

function writePublishFailure(parsed: Pick<ParsedContentArgs, "json">, context: ContentCliContext, failure: ContentCliFailure, verb: "published" | "scheduled"): number {
  if (parsed.json) return writeFailure(parsed, context, failure)
  const changed = changedDocuments(failure)
  if (changed.length) {
    const lines = changed.map(({ actual, collection, expected, id }) =>
      `  ${collection}/${id}  ${actual === null ? "deleted on the draft" : `draft is now ${shortDigest(actual)}`} (you confirmed ${shortDigest(expected)})`)
    context.stderr.write([
      `Nothing was ${verb}. ${plural(changed.length, "draft")} changed after you confirmed:`,
      ...lines,
      `Review them with \`vitehub content diff <collection> <id>\`, then run the ${verb === "published" ? "publish" : "schedule"} again.`,
      "",
    ].join("\n"))
    return 1
  }
  const invalid = invalidDocuments(failure)
  if (invalid.length) {
    context.stderr.write([
      `Nothing was ${verb}. ${plural(invalid.length, "draft")} ${invalid.length === 1 ? "has" : "have"} invalid fields:`,
      ...invalid.flatMap(({ collection, id, issues }) => [`  ${collection}/${id}`, ...issueLines(issues, "    ")]),
      "Fix them with `vitehub content edit <collection> <id>`, then run the command again.",
      "",
    ].join("\n"))
    return 1
  }
  return writeFailure(parsed, context, failure)
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

/** `$VISUAL` or `$EDITOR`, else `vi`, on an interactive terminal. Undefined without one. */
function defaultEditor(env: NodeJS.ProcessEnv): ((file: string) => Promise<void>) | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return
  const command = env.VISUAL || env.EDITOR || "vi"
  return async (file) => {
    const { spawn } = await import("node:child_process")
    // The editor variable may hold arguments, such as `code --wait`, so the shell splits it.
    const child = spawn(`${command} ${JSON.stringify(file)}`, { shell: true, stdio: "inherit" })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", resolve)
    })
    if (code !== 0) throw new Error(`The editor \`${command}\` exited with code ${code}.`)
  }
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString("utf8")
}

type ContentDevRequestOptions = Omit<ContentDevRequestBody, "operation">

interface ContentDevResults {
  collections: ContentDevCollectionsResult
  diff: ContentDevDiffResult
  list: ContentDevListResult
  publish: ContentDevPublishResult
  revisions: ContentDevRevisionsResult
  save: ContentDevSaveResult
  schedule: ContentSchedule
  schedules: ContentDevSchedulesResult
  show: ContentDevShowResult
  sitemap: ContentDevSitemapResult
  status: ContentDevStatusResult
  unschedule: ContentDevUnscheduleResult
}

/** One request to the dev endpoint, typed by the result that the Nitro handler returns for the operation. */
type ContentDevCall = <TOperation extends ContentDevOperation>(
  operation: TOperation,
  options: ContentDevRequestOptions,
) => Promise<{ failure: ContentCliFailure, result?: undefined } | { failure?: undefined, result: ContentDevResults[TOperation] }>

/** Ask before a write, unless `--yes`. Returns an exit code when the user did not confirm. */
async function confirmWrite(parsed: ParsedContentArgs, context: ContentCliContext, options: ContentCliOptions, action: "Publish" | "Schedule"): Promise<number | undefined> {
  if (parsed.yes) return
  const confirmed = options.confirm ? await options.confirm(`${action}? [y/N] `) : await defaultConfirm(`${action}? [y/N] `)
  if (confirmed === undefined) {
    return writeFailure(parsed, context, { code: "CONTENT_PUBLISH_UNCONFIRMED", message: `${action === "Publish" ? "Publishing" : "Scheduling"} needs confirmation. Pass --yes to ${action.toLowerCase()} without a prompt, or --dry-run to only list the changes.` })
  }
  if (!confirmed) return writeFailure(parsed, context, { code: "CONTENT_PUBLISH_CANCELLED", message: `${action} cancelled.` })
}

/**
 * Publish or schedule the drafts that a dry run lists. Both pin the listed draft digests: a draft saved after the list
 * fails the write, so exactly what the user confirmed goes out, or nothing.
 */
async function runPublish(
  command: ContentCliCommand,
  parsed: ParsedContentArgs,
  context: ContentCliContext,
  call: ContentDevCall,
  options: ContentCliOptions,
): Promise<number> {
  const scheduling = command.name === "schedule"
  const plan = await call("publish", { ...requestBody(parsed), dryRun: true })
  if (plan.failure) return writeFailure(parsed, context, plan.failure)
  const pending = plan.result
  const verb = scheduling ? "schedule" : "publish"
  if (parsed.dryRun || !pending.documents.length) {
    if (parsed.json) context.stdout.write(`${JSON.stringify(pending, null, 2)}\n`)
    else if (!pending.documents.length) context.stderr.write(`Nothing to ${verb}: every selected document is published as drafted.\n`)
    else context.stdout.write(`Would ${verb} ${plural(pending.documents.length, "document")}${scheduling && parsed.at ? ` at ${parsed.at}` : ""}:\n${changeLines(pending.documents)}\n`)
    return 0
  }
  // A draft with field issues fails the write anyway, so the command skips the prompt and reports them.
  const invalid = pending.documents.some(document => document.issues)
  if (!invalid) {
    if (!parsed.yes && !parsed.json) {
      context.stderr.write(`${scheduling ? "Schedule" : "Publish"} ${plural(pending.documents.length, "document")}${scheduling ? ` at ${parsed.at}` : ""}:\n${changeLines(pending.documents)}\n`)
    }
    const declined = await confirmWrite(parsed, context, options, scheduling ? "Schedule" : "Publish")
    if (declined !== undefined) return declined
  }
  const expect = pending.documents.map(({ collection, id, digest }) => ({ collection, id, digest: digest ?? null }))
  const message = parsed.message === undefined ? {} : { message: parsed.message }
  if (scheduling) {
    const scheduled = await call("schedule", { at: parsed.at, expect, ...message })
    if (scheduled.failure) return writePublishFailure(parsed, context, scheduled.failure, "scheduled")
    if (parsed.json) context.stdout.write(`${JSON.stringify(scheduled.result, null, 2)}\n`)
    else context.stdout.write(`Scheduled ${plural(scheduled.result.expect.length, "document")} for ${scheduled.result.at} as ${scheduled.result.id}.\nCancel it with \`vitehub content unschedule ${scheduled.result.id}\`.\n`)
    return 0
  }
  const published = await call("publish", { expect, ...message })
  if (published.failure) return writePublishFailure(parsed, context, published.failure, "published")
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

/** The holder of an edit lease, from `CONTENT_LEASE_HELD` details. */
function leaseHolder(failure: ContentCliFailure): string | undefined {
  if (failure.code !== "CONTENT_LEASE_HELD" || !isRecord(failure.details) || !isRecord(failure.details.holder)) return
  const holder = failure.details.holder
  const user = isRecord(holder.user) ? holder.user : {}
  const name = String(user.name) === user.name && user.name ? user.name : String(user.id ?? "Someone")
  const since = String(holder.since) === holder.since ? ` since ${holder.since}` : ""
  return `${holder.kind === "live" ? `A live session (${name})` : name} holds the edit lease${since}`
}

function writeSaveFailure(parsed: Pick<ParsedContentArgs, "json">, context: ContentCliContext, failure: ContentCliFailure, document: string, kept?: string): number {
  if (parsed.json) return writeFailure(parsed, context, failure)
  const retry = kept ? `Your edit is kept in ${kept}. Save it with \`vitehub content edit ${document.replace("/", " ")} --file ${kept}\`.` : ""
  const holder = leaseHolder(failure)
  if (holder) {
    context.stderr.write(`Nothing was saved. ${holder} on ${document}.\nWait until they finish, or pass --override-lease to save anyway.\n${retry ? `${retry}\n` : ""}`)
    return 1
  }
  if (failure.code === "WORKSPACE_CONFLICT") {
    const details = isRecord(failure.details) ? failure.details : {}
    const actual = String(details.actual) === details.actual ? `draft is now ${shortDigest(details.actual)}` : "the draft was deleted"
    context.stderr.write(`Nothing was saved. ${document} changed after you opened it (${actual}).\n${retry ? `${retry}\n` : "Run the edit again.\n"}`)
    return 1
  }
  context.stderr.write(`${failure.message}\n${retry ? `${retry}\n` : ""}`)
  return 1
}

/** Edit one draft in an editor, or save it from `--file`. The save honours edit leases unless `--override-lease`. */
async function runEdit(parsed: ParsedContentArgs, context: ContentCliContext, call: ContentDevCall, options: ContentCliOptions): Promise<number> {
  const target = { collection: parsed.collection!, ...(parsed.id === undefined ? {} : { id: parsed.id }) }
  const save = { ...target, ...(parsed.message === undefined ? {} : { message: parsed.message }), ...(parsed.overrideLease ? { lease: "override" as const } : {}) }
  let text: string
  let ifDigest: string | null | undefined
  let document = `${target.collection}${target.id === undefined ? "" : `/${target.id}`}`
  let kept: string | undefined
  let cleanup: (() => Promise<void>) | undefined
  if (parsed.file !== undefined) {
    try {
      text = parsed.file === "-" ? await readStandardInput() : await readFile(resolve(context.cwd, parsed.file), "utf8")
    }
    catch (error) {
      return writeFailure(parsed, context, { message: `Could not read ${parsed.file}: ${error instanceof Error ? error.message : String(error)}` })
    }
    ifDigest = parsed.ifDigest
  }
  else {
    const editor = options.editor ?? defaultEditor(context.env)
    if (!editor) return writeFailure(parsed, context, { code: "CONTENT_R0010", message: "`vitehub content edit` needs --file <path> or an interactive terminal for $EDITOR." })
    const shown = await call("show", { ...target, create: true })
    if (shown.failure) return writeFailure(parsed, context, shown.failure)
    document = `${shown.result.collection}/${shown.result.id}`
    const directory = await mkdtemp(join(tmpdir(), "vitehub-content-"))
    const file = join(directory, basename(shown.result.path))
    cleanup = () => rm(directory, { force: true, recursive: true })
    await writeFile(file, shown.result.text, "utf8")
    try {
      await editor(file)
    }
    catch (error) {
      await cleanup()
      return writeFailure(parsed, context, { message: error instanceof Error ? error.message : String(error) })
    }
    text = await readFile(file, "utf8")
    if (text === shown.result.text) {
      await cleanup()
      context.stderr.write(`No changes: ${document} was not saved.\n`)
      return 0
    }
    ifDigest = shown.result.digest
    kept = file
  }
  const saved = await call("save", { ...save, text, ...(ifDigest === undefined ? {} : { ifDigest }) })
  if (saved.failure) return writeSaveFailure(parsed, context, saved.failure, document, kept)
  await cleanup?.()
  const result = saved.result
  if (parsed.json) {
    context.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  context.stdout.write(`Saved ${result.collection}/${result.id} to the draft as ${shortDigest(result.digest)}.\n`)
  if (result.issues?.length) {
    context.stderr.write([
      `The draft has ${plural(result.issues.length, "field issue")}. Publishing refuses it until they are fixed:`,
      ...issueLines(result.issues),
      "",
    ].join("\n"))
  }
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
  const print = (result: unknown) => context.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  switch (command.name) {
    case "publish":
    case "schedule":
      return await runPublish(command, parsed, context, call, options)
    case "edit":
      return await runEdit(parsed, context, call, options)
    case "diff": {
      const { failure, result } = await call("diff", requestBody(parsed))
      if (failure) return writeFailure(parsed, context, failure)
      const patch = contentDocumentDiff(result)
      if (parsed.json) print({ ...result, diff: patch })
      else if (!patch) context.stderr.write(`No changes: ${result.collection}/${result.id} is published as drafted.\n`)
      else context.stdout.write(patch)
      return 0
    }
    case "show": {
      const { failure, result } = await call("show", requestBody(parsed))
      if (failure) return writeFailure(parsed, context, failure)
      if (parsed.json) print(result)
      else {
        context.stdout.write(result.text)
        if (result.issues?.length) {
          context.stderr.write([`${result.collection}/${result.id} has ${plural(result.issues.length, "field issue")} on ${result.ref}:`, ...issueLines(result.issues), ""].join("\n"))
        }
      }
      return 0
    }
    case "unschedule": {
      const { failure, result } = await call("unschedule", { schedule: parsed.schedule })
      if (failure) return writeFailure(parsed, context, failure)
      if (parsed.json) print(result)
      else context.stdout.write(`Removed schedule ${result.schedule}. Nothing it named was published.\n`)
      return 0
    }
    case "sitemap": {
      const { failure, result } = await call("sitemap", requestBody(parsed))
      if (failure) return writeFailure(parsed, context, failure)
      if (parsed.json) print(result)
      else writeSitemap(result, parsed, context)
      return 0
    }
    case "collections": {
      const { failure, result } = await call("collections", {})
      if (failure) return writeFailure(parsed, context, failure)
      if (parsed.json) print(result)
      else writeCollections(result, context)
      return 0
    }
    case "list": {
      const { failure, result } = await call("list", requestBody(parsed))
      if (failure) return writeFailure(parsed, context, failure)
      if (parsed.json) print(result)
      else writeList(result, context)
      return 0
    }
    case "status": {
      const { failure, result } = await call("status", requestBody(parsed))
      if (failure) return writeFailure(parsed, context, failure)
      if (parsed.json) print(result)
      else writeStatus(result, context)
      return 0
    }
    case "revisions": {
      const { failure, result } = await call("revisions", requestBody(parsed))
      if (failure) return writeFailure(parsed, context, failure)
      if (parsed.json) print(result)
      else writeRevisions(result, context)
      return 0
    }
    case "scheduled": {
      const { failure, result } = await call("schedules", requestBody(parsed))
      if (failure) return writeFailure(parsed, context, failure)
      if (parsed.json) print(result)
      else writeSchedules(result, context)
      return 0
    }
  }
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
      description: "Inspect, edit, publish, and schedule Content documents in a running Vite + Nitro Development Server.",
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
