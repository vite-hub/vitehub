import {
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
} from "@vite-hub/internal/cli"
import { readViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { redactInspectionText } from "@vite-hub/internal/inspect"
import { isPlainObject } from "@vite-hub/internal/object"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

import { workspaceErrorDiagnostics } from "./error-diagnostics.ts"
import {
  workspaceHistoryDevHeader,
  workspaceHistoryDevHeaderValue,
  workspaceHistoryDevRoute,
  workspaceHistoryDevTokenNamespace,
  workspaceHistoryDevTokenServerHeader,
} from "./history-dev.ts"

import type {
  WorkspaceHistoryDevDetails,
  WorkspaceHistoryDevFile,
  WorkspaceHistoryDevList,
  WorkspaceHistoryDevRefs,
  WorkspaceHistoryDevRequest,
  WorkspaceHistoryDevRevision,
} from "./history-dev.ts"

export interface WorkspaceHistoryCliContext {
  cwd: string
  env: NodeJS.ProcessEnv
  rootDir: string
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

export interface WorkspaceHistoryCliOptions {
  fetch?: typeof fetch
}

export type WorkspaceHistoryCommand = WorkspaceHistoryDevRequest["operation"]

interface ParsedHistoryArgs {
  cursor?: string
  help: boolean
  json: boolean
  limit?: number
  positionals: string[]
  ref?: string
  timeout?: number
  url: string
}

interface CommandSpec {
  description: string
  options: string[]
  summary: string
  usage: string
}

const commandNames = ["history", "refs", "show"] as const satisfies readonly WorkspaceHistoryCommand[]

const commands: Record<WorkspaceHistoryCommand, CommandSpec> = {
  history: {
    description: "List retained revisions of a Workspace, newest first. Without --ref, the list merges every ref.",
    options: [
      "  --ref <ref>       List one ref only.",
      "  --limit <n>       Show at most n revisions, from 1 to 100. Defaults to 20.",
      "  --cursor <value>  Continue a --ref list from the cursor of the previous page.",
    ],
    summary: "List retained revisions with ref, author, message, and time.",
    usage: "vitehub workspace history <workspace> [--ref <ref>] [--limit <n>] [--cursor <value>] [--json] [--url <url>]",
  },
  refs: {
    description: "List the history refs of a Workspace and the head revision of each ref.",
    options: [],
    summary: "List history refs and their head revisions.",
    usage: "vitehub workspace refs <workspace> [--json] [--url <url>]",
  },
  show: {
    description: "Show one revision and its files. With a file path, print the file content as it was in that revision.",
    options: [],
    summary: "Show a revision, its files, or one file at that revision.",
    usage: "vitehub workspace show <workspace> <ref|revision> [path] [--json] [--url <url>]",
  },
}

const workspaceHistoryDevEndpoint = {
  header: workspaceHistoryDevHeader,
  headerValue: workspaceHistoryDevHeaderValue,
  route: workspaceHistoryDevRoute,
}

// Nuxt mounts Vite under `/_nuxt/`, so the history dev endpoint is not reachable there.
const workspaceHistoryDevServerHint = "`vitehub workspace history`, `refs`, and `show` need a running Vite + Nitro Development Server with `workspace` enabled. Nuxt and plain Vite are not supported."

const workspaceDevTargetErrors = {
  invalidInlineTimeout: (message: string) => workspaceErrorDiagnostics.WORKSPACE_R0006({ message }),
  invalidTimeout: (message: string) => workspaceErrorDiagnostics.WORKSPACE_R0005({ message }),
  missingValue: (message: string) => workspaceErrorDiagnostics.WORKSPACE_R0004({ message }),
}

function writeUsage(command: WorkspaceHistoryCommand, stream: WorkspaceHistoryCliContext["stdout"]): void {
  const spec = commands[command]
  stream.write([
    `Usage: ${spec.usage}`,
    "",
    spec.description,
    "The command reads the Workspace Store in the Nitro runtime of a running Vite Development Server. It does not write.",
    "",
    "Options:",
    ...spec.options,
    "  --json            Print JSON.",
    "  --url <url>       Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --timeout <ms>    Request timeout in milliseconds.",
    "  -h, --help        Show this help.",
    "  --                End options before a path that starts with a dash.",
    "",
  ].join("\n"))
}

function setHistoryOption(parsed: ParsedHistoryArgs, flag: string, value: string | undefined): string | undefined {
  if (!value || value.startsWith("-")) return `Missing value for ${flag}.`
  if (flag === "--ref") parsed.ref = value
  else if (flag === "--cursor") parsed.cursor = value
  else if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100) parsed.limit = Number(value)
  else return "--limit must be an integer from 1 to 100."
}

/** Parses command arguments. Returns an error message for invalid input. */
function parseArgs(command: WorkspaceHistoryCommand, args: readonly string[], env: NodeJS.ProcessEnv): ParsedHistoryArgs | string {
  const parsed: ParsedHistoryArgs = { help: false, json: false, positionals: [], url: resolveViteHubDevServerUrl(env) }
  const historyOption = /^(--(?:ref|limit|cursor))(?:=(.*))?$/s
  let positionalOnly = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const option = command === "history" ? historyOption.exec(arg) : null
    if (positionalOnly || !arg.startsWith("-")) parsed.positionals.push(arg)
    else if (arg === "--") positionalOnly = true
    else if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--json") parsed.json = true
    else if (option) {
      const inline = option[2] !== undefined
      const error = setHistoryOption(parsed, option[1]!, inline ? option[2] : args[index + 1])
      if (error) return error
      if (!inline) index += 1
    }
    else {
      let used
      try {
        used = readViteHubDevTargetOption(args, index, parsed, workspaceDevTargetErrors)
      }
      catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      if (used === undefined) return `Unknown option: ${arg}.`
      index += used
    }
  }
  if (parsed.help) return parsed
  const [minimum, maximum] = command === "show" ? [2, 3] : [1, 1]
  if (parsed.positionals.length < minimum) return parsed.positionals.length ? "Missing ref or revision." : "Missing Workspace name."
  if (parsed.positionals.length > maximum) return `Unexpected argument: ${parsed.positionals[maximum]}.`
  if (parsed.cursor !== undefined && parsed.ref === undefined) return "--cursor requires --ref."
  return parsed
}

function createRequest(command: WorkspaceHistoryCommand, parsed: ParsedHistoryArgs): WorkspaceHistoryDevRequest {
  const [workspace = "", target = "", path] = parsed.positionals
  if (command === "refs") return { operation: "refs", workspace }
  if (command === "show") {
    const request: WorkspaceHistoryDevRequest = { operation: "show", workspace, target }
    if (path !== undefined) request.path = path
    return request
  }
  const request: Extract<WorkspaceHistoryDevRequest, { operation: "history" }> = { operation: "history", workspace }
  if (parsed.cursor !== undefined) request.cursor = parsed.cursor
  if (parsed.limit !== undefined) request.limit = parsed.limit
  if (parsed.ref !== undefined) request.ref = parsed.ref
  return request
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")).join("\n")
}

function oneLine(value: string | undefined): string {
  return value?.split(/\r?\n/, 1)[0]?.trim() || "-"
}

function formatHistory(result: WorkspaceHistoryDevList): string {
  if (!result.revisions.length) return result.ref ? `No revisions on ref ${result.ref}.\n` : "No revisions.\n"
  const lines = [table([
    ["REVISION", "REF", "CREATED AT", "AUTHOR", "FILES", "MESSAGE"],
    ...result.revisions.map(revision => [revision.id, revision.ref, revision.createdAt, revision.author ?? "-", String(revision.files), oneLine(revision.message)]),
  ])]
  if (result.cursor && result.ref) lines.push(`More revisions: vitehub workspace history ${result.workspace} --ref ${result.ref} --cursor ${result.cursor}`)
  else if (result.more) lines.push("More revisions exist. Use --ref <ref> to page through one ref.")
  return `${lines.join("\n")}\n`
}

function formatRefs(result: WorkspaceHistoryDevRefs): string {
  if (!result.refs.length) return "No refs. The Workspace has no retained revisions yet.\n"
  return `${table([
    ["REF", "HEAD", "CREATED AT", "AUTHOR", "MESSAGE"],
    ...result.refs.map(ref => [ref.name, ref.head.id, ref.head.createdAt, ref.head.author ?? "-", oneLine(ref.head.message)]),
  ])}\n`
}

function formatFiles(files: readonly WorkspaceHistoryDevFile[]): string {
  if (!files.length) return "No files."
  return table([
    ["PATH", "SIZE", "MEDIA TYPE", "DIGEST"],
    ...files.map(file => [file.path, file.size === undefined ? "-" : String(file.size), file.mediaType ?? "-", file.digest ?? "-"]),
  ])
}

function formatRevision(revision: WorkspaceHistoryDevRevision): string[] {
  return [
    `Revision: ${revision.id}`,
    `Ref: ${revision.ref}`,
    `Parent: ${revision.parentId ?? "-"}`,
    `Created at: ${revision.createdAt}`,
    `Author: ${revision.author ?? "-"}`,
    `Message: ${revision.message ?? "-"}`,
    `Files: ${revision.files} (${revision.bytes} bytes)`,
  ]
}

function formatShow(result: WorkspaceHistoryDevDetails): string | Uint8Array {
  if (result.file) return result.file.encoding === "utf8" ? result.file.content : Buffer.from(result.file.content, "base64")
  return `${[...formatRevision(result.revision), ...(result.path ? [`Path: ${result.path}`] : []), "", formatFiles(result.files ?? [])].join("\n")}\n`
}

function isRevision(value: unknown): value is WorkspaceHistoryDevRevision {
  return isPlainObject(value) && hasRuntimeType(value.id, "string") && hasRuntimeType(value.ref, "string")
    && hasRuntimeType(value.createdAt, "string") && hasRuntimeType(value.files, "number") && hasRuntimeType(value.bytes, "number")
    && (value.parentId === null || hasRuntimeType(value.parentId, "string"))
    && (value.author === undefined || hasRuntimeType(value.author, "string"))
    && (value.message === undefined || hasRuntimeType(value.message, "string"))
}

function isFile(value: unknown): value is WorkspaceHistoryDevFile {
  return isPlainObject(value) && hasRuntimeType(value.path, "string")
    && (value.size === undefined || hasRuntimeType(value.size, "number"))
    && (value.mediaType === undefined || hasRuntimeType(value.mediaType, "string"))
    && (value.digest === undefined || hasRuntimeType(value.digest, "string"))
}

function isHistoryList(value: Record<string, unknown>): value is Record<string, unknown> & WorkspaceHistoryDevList {
  return hasRuntimeType(value.workspace, "string") && Array.isArray(value.revisions) && value.revisions.every(isRevision)
    && hasRuntimeType(value.more, "boolean")
    && (value.ref === undefined || hasRuntimeType(value.ref, "string"))
    && (value.cursor === undefined || hasRuntimeType(value.cursor, "string"))
}

function isRefList(value: Record<string, unknown>): value is Record<string, unknown> & WorkspaceHistoryDevRefs {
  return hasRuntimeType(value.workspace, "string") && Array.isArray(value.refs)
    && value.refs.every(ref => isPlainObject(ref) && hasRuntimeType(ref.name, "string") && isRevision(ref.head))
}

function isRevisionDetails(value: Record<string, unknown>): value is Record<string, unknown> & WorkspaceHistoryDevDetails {
  if (!hasRuntimeType(value.workspace, "string") || !isRevision(value.revision)) return false
  if (value.path !== undefined && !hasRuntimeType(value.path, "string")) return false
  const file = value.file
  if (file === undefined) return Array.isArray(value.files) && value.files.every(isFile)
  return isPlainObject(file) && isFile(file) && hasRuntimeType(file.content, "string") && (file.encoding === "utf8" || file.encoding === "base64")
}

function formatResult(command: WorkspaceHistoryCommand, result: Record<string, unknown>): string | Uint8Array | undefined {
  if (command === "history" && isHistoryList(result)) return formatHistory(result)
  if (command === "refs" && isRefList(result)) return formatRefs(result)
  if (command === "show" && isRevisionDetails(result)) return formatShow(result)
}

async function readFailure(response: Response): Promise<{ code?: string, message: string }> {
  const text = await response.text()
  try {
    const body: unknown = JSON.parse(text)
    if (isPlainObject(body) && isPlainObject(body.error) && hasRuntimeType(body.error.message, "string")) {
      const failure: { code?: string, message: string } = { message: body.error.message }
      if (hasRuntimeType(body.error.code, "string")) failure.code = body.error.code
      return failure
    }
  }
  catch {
    // Guard rejections use plain text.
  }
  return { message: text || `Workspace history request failed with HTTP ${response.status}.` }
}

function writeFailure(json: boolean, context: WorkspaceHistoryCliContext, failure: { code?: string, message: string }): number {
  const redacted = { ...failure, message: redactInspectionText(failure.message) }
  if (json) context.stdout.write(`${JSON.stringify({ error: redacted }, null, 2)}\n`)
  else context.stderr.write(`${redacted.message}\n`)
  return 1
}

/** Runs `vitehub workspace history`, `refs`, or `show` against a running Vite Development Server. */
export async function runWorkspaceHistoryCli(
  command: WorkspaceHistoryCommand,
  args: string[],
  context: WorkspaceHistoryCliContext,
  options: WorkspaceHistoryCliOptions = {},
): Promise<number> {
  const parsed = parseArgs(command, args, context.env)
  if (hasRuntimeType(parsed, "string")) {
    const optionEnd = args.indexOf("--")
    if (args.slice(0, optionEnd === -1 ? args.length : optionEnd).includes("--json")) return writeFailure(true, context, { message: parsed })
    context.stderr.write(`${parsed}\n`)
    writeUsage(command, context.stderr)
    return 1
  }
  if (parsed.help) {
    writeUsage(command, context.stdout)
    return 0
  }
  const request = createRequest(command, parsed)
  const fetchImpl = options.fetch ?? globalThis.fetch
  const signal = parsed.timeout ? AbortSignal.timeout(parsed.timeout) : undefined
  let discoveryFailure = ""
  const server = await discoverViteHubDevServer<{ message?: unknown, root?: unknown, runtime?: unknown, workspaceHistoryDevTokenServerId?: unknown }>({
    endpoint: workspaceHistoryDevEndpoint,
    fetch: fetchImpl,
    rootDir: context.rootDir,
    serverUrl: parsed.url,
    signal,
    stderr: { write: (chunk) => { discoveryFailure += String(chunk) } },
  })
  if (!server) return writeFailure(parsed.json, context, { message: `${discoveryFailure.trim()}\n${workspaceHistoryDevServerHint}` })
  if (server.discovery.runtime !== "nitro") {
    return writeFailure(parsed.json, context, {
      code: "WORKSPACE_HISTORY_DEV_RUNTIME_UNAVAILABLE",
      message: hasRuntimeType(server.discovery.message, "string") ? server.discovery.message : workspaceHistoryDevServerHint,
    })
  }
  const serverId = server.discovery.workspaceHistoryDevTokenServerId
  if (!hasRuntimeType(serverId, "string") || !serverId) {
    return writeFailure(parsed.json, context, { message: "The Workspace History endpoint did not provide a token server ID. Restart the Compatible Vite Development Server." })
  }
  let token: string | undefined
  try {
    token = await readViteHubDevToken(context.rootDir, { namespace: workspaceHistoryDevTokenNamespace, serverId })
  }
  catch (error) {
    return writeFailure(parsed.json, context, { message: `Could not read the private Workspace History token: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (!token) return writeFailure(parsed.json, context, { message: "No private Workspace History token found. Start the Compatible Vite Development Server first." })
  let response: Response
  try {
    response = await fetchViteHubDevEndpoint(fetchImpl, server.url, workspaceHistoryDevEndpoint, {
      body: JSON.stringify(request),
      headers: { accept: "application/json", "content-type": "application/json", [viteHubDevTokenHeader]: token, [workspaceHistoryDevTokenServerHeader]: serverId },
      method: "POST",
      signal,
    })
  }
  catch (error) {
    return writeFailure(parsed.json, context, { message: `Workspace history request failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (!response.ok) return writeFailure(parsed.json, context, await readFailure(response))
  const result: unknown = await response.json().catch(() => undefined)
  const formatted = isPlainObject(result) ? formatResult(command, result) : undefined
  if (!isPlainObject(result) || formatted === undefined) return writeFailure(parsed.json, context, { message: "The Workspace history response has an invalid shape." })
  context.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatted)
  return 0
}

/** `vitehub workspace` features that read retained history. */
export const workspaceHistoryCliFeatures = commandNames.map(command => ({
  description: commands[command].summary,
  name: command,
  run: async (args: string[], context: WorkspaceHistoryCliContext) => await runWorkspaceHistoryCli(command, args, context),
  usage: commands[command].usage,
}))
