import { readFile } from "node:fs/promises"
import { relative, resolve } from "node:path"

import * as v from "valibot"

import {
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
} from "@vite-hub/internal/cli"

import { emailDevHeader, emailDevHeaderValue, emailDevRoute } from "./dev.ts"
import { emailErrorDiagnostics } from "./error-diagnostics.ts"
import { renderEmailMarkdown } from "./markdown.ts"
import { discoverEmailTemplates } from "./templates.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { EmailDevOperation, EmailDevRequestBody } from "./dev.ts"
import type { EmailOutboxDelivery, EmailOutboxList, EmailOutboxMessage } from "./runtime/console.ts"

export type EmailCliContext = Pick<ViteHubCliContext, "cwd" | "env" | "rootDir"> & ViteHubCliStreams

export interface EmailCliOptions {
  fetch?: typeof fetch
  /** Directories that hold Email templates. The Vite plugin passes its `server/emails` roots. */
  templateRoots?: () => readonly string[]
}

type OutboxBodyFormat = "html" | "json" | "text"

interface ParsedOutboxArgs {
  format?: OutboxBodyFormat
  help: boolean
  id?: string
  json: boolean
  timeout?: number
  url: string
}

interface OutboxCommand {
  description: string
  formats?: boolean
  id?: boolean
  name: "clear" | "list" | "show"
  operation: EmailDevOperation
}

interface EmailDevDiscovery {
  message?: unknown
  root?: unknown
  runtime?: unknown
}

const emailDevDiscoverySchema = v.object({
  message: v.optional(v.string()),
  root: v.optional(v.string()),
  runtime: v.optional(v.string()),
})

function parseEmailDevDiscovery(value: unknown): EmailDevDiscovery {
  const parsed = v.safeParse(emailDevDiscoverySchema, value)
  if (parsed.success) return parsed.output
  if (!v.is(v.record(v.string(), v.unknown()), value)) return {}
  const record = value
  const output: EmailDevDiscovery = {}
  if ("root" in record) output.root = record.root
  for (const key of ["message", "runtime"] as const) {
    const field = v.safeParse(v.string(), record[key])
    if (field.success) output[key] = field.output
  }
  return output
}

const emailDevEndpoint = {
  header: emailDevHeader,
  headerValue: emailDevHeaderValue,
  route: emailDevRoute,
}

const usageError = (message: string) => emailErrorDiagnostics.EMAIL_CLI_USAGE({ problem: message })

const emailDevTargetErrors = {
  invalidInlineTimeout: usageError,
  invalidTimeout: usageError,
  missingValue: usageError,
}

// Nuxt mounts Vite under `/_nuxt/`, so the Email dev endpoint is not reachable there.
const emailDevServerHint = "`vitehub email outbox` needs a running Vite + Nitro Development Server with `email` enabled. Nuxt and plain Vite are not supported."

const outboxCommands: readonly OutboxCommand[] = [
  { description: "List captured messages, newest first.", name: "list", operation: "list" },
  { description: "Show one captured message.", formats: true, id: true, name: "show", operation: "get" },
  { description: "Remove every captured message.", name: "clear", operation: "clear" },
]

const outboxUsage = "vitehub email outbox <list|show|clear> [<id>] [--html|--text|--json] [--url <url>]"
const previewUsage = "vitehub email preview <template> [--data <json|@file>] [--html|--text|--json]"

function outboxCommandUsage(command: OutboxCommand): string {
  return `vitehub email outbox ${command.name}${command.id ? " <id>" : ""}${command.formats ? " [--html|--text|--json]" : " [--json]"} [--url <url>]`
}

function writeOutboxUsage(command: OutboxCommand, stream: ViteHubCliStreams["stdout"]): void {
  stream.write([
    `Usage: ${outboxCommandUsage(command)}`,
    "",
    command.description,
    "The command reads the development outbox of a running Vite + Nitro Development Server.",
    "",
    "Options:",
    ...(command.formats
      ? [
          "  --html            Print only the HTML source.",
          "  --text            Print only the text body.",
        ]
      : []),
    "  --json            Print JSON.",
    "  --url <url>       Compatible Vite Development Server URL. Defaults to http://localhost:5173.",
    "  --timeout <ms>    Request timeout.",
    "  -h, --help        Show this help.",
    "",
  ].join("\n"))
}

function writeOutboxCommands(stream: ViteHubCliStreams["stdout"]): void {
  stream.write([
    `Usage: ${outboxUsage}`,
    "",
    "Commands:",
    ...outboxCommands.map(command => `  ${command.name.padEnd(8)} ${command.description}`),
    "",
  ].join("\n"))
}

function setFormat(parsed: ParsedOutboxArgs, format: OutboxBodyFormat): void {
  if (parsed.format && parsed.format !== format) throw usageError("Use only one of --html, --text, and --json.")
  parsed.format = format
}

function parseOutboxArgs(command: OutboxCommand, args: readonly string[], env: NodeJS.ProcessEnv): ParsedOutboxArgs {
  const parsed: ParsedOutboxArgs = { help: false, json: false, url: resolveViteHubDevServerUrl(env) }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") {
      parsed.help = true
      continue
    }
    if (arg === "--json") {
      parsed.json = true
      if (command.formats) setFormat(parsed, "json")
      continue
    }
    if (command.formats && (arg === "--html" || arg === "--text")) {
      setFormat(parsed, arg === "--html" ? "html" : "text")
      continue
    }
    const targetOption = readViteHubDevTargetOption(args, index, parsed, emailDevTargetErrors)
    if (targetOption !== undefined) {
      index += targetOption
      continue
    }
    if (arg.startsWith("-")) throw usageError(`Unknown option: ${arg}.`)
    if (command.id && parsed.id === undefined) {
      parsed.id = arg
      continue
    }
    throw usageError(`Unexpected argument: ${arg}.`)
  }
  if (!parsed.help && command.id && !parsed.id) throw usageError("Missing outbox message id.")
  return parsed
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ")).join("\n")
}

function deliveryLabel(delivery: EmailOutboxDelivery): string {
  switch (delivery.status) {
    case "pending":
      return "Sending"
    case "captured":
      return "captured"
    case "sent":
      return `sent ${delivery.id}`
    case "failed":
      return `failed${delivery.error.code ? ` ${delivery.error.code}` : ""}`
  }
}

function shorten(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 3)}...` : value
}

function formatOutboxList(result: EmailOutboxList): string {
  if (result.messages.length === 0) return "No captured messages.\n"
  return `${table([
    ["ID", "CAPTURED", "PROVIDER", "DELIVERY", "TO", "SUBJECT"],
    ...result.messages.map(message => [
      message.id,
      message.capturedAt,
      message.provider,
      deliveryLabel(message.delivery),
      shorten(message.to.join(", "), 40),
      shorten(message.subject, 60),
    ]),
  ])}\n${result.messages.length} message${result.messages.length === 1 ? "" : "s"}${result.limit === null ? "" : ` (limit ${result.limit})`}.\n`
}

function formatMessage(message: EmailOutboxMessage): string {
  const headers = Object.entries(message.headers)
  return [
    `Message: ${message.id}`,
    `Captured: ${message.capturedAt}`,
    `Provider: ${message.provider}`,
    `Delivery: ${deliveryLabel(message.delivery)}${message.delivery.status === "failed" ? `: ${message.delivery.error.message}` : ""}`,
    `From: ${message.from}`,
    `To: ${message.to.join(", ")}`,
    ...(message.cc?.length ? [`Cc: ${message.cc.join(", ")}`] : []),
    ...(message.bcc?.length ? [`Bcc: ${message.bcc.join(", ")}`] : []),
    ...(message.replyTo?.length ? [`Reply-To: ${message.replyTo.join(", ")}`] : []),
    `Subject: ${message.subject}`,
    ...(message.preheader ? [`Preheader: ${message.preheader}`] : []),
    ...(message.scheduledAt ? [`Scheduled at: ${message.scheduledAt}`] : []),
    ...(message.template ? [`Provider template: ${message.template}`] : []),
    ...(headers.length ? ["Headers:", ...headers.map(([name, value]) => `  ${name}: ${value}`)] : []),
    ...(message.attachments.length
      ? ["Attachments:", ...message.attachments.map(attachment => `  ${attachment.filename} (${[attachment.contentType, `${attachment.size} bytes`, attachment.disposition].filter(Boolean).join(", ")})`)]
      : []),
    `HTML: ${message.html === undefined ? "none" : `${message.html.length} characters. Use --html to print it.`}`,
    "",
    message.text ?? "(no text body)",
    "",
  ].join("\n")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !Array.isArray(value) && v.is(v.record(v.string(), v.unknown()), value)
}

const deliverySchema = v.variant("status", [
  v.object({ status: v.literal("captured") }),
  v.object({ status: v.literal("pending") }),
  v.object({ id: v.string(), status: v.literal("sent") }),
  v.object({ error: v.object({ code: v.optional(v.string()), message: v.string() }), status: v.literal("failed") }),
])
const messageFields = { capturedAt: v.string(), delivery: deliverySchema, from: v.string(), id: v.string(), provider: v.string(), subject: v.string(), to: v.array(v.string()) }
const attachmentSchema = v.object({ cid: v.optional(v.string()), contentType: v.optional(v.string()), disposition: v.optional(v.picklist(["attachment", "inline"])), filename: v.string(), size: v.pipe(v.number(), v.finite()) })
const outboxMessageSchema = v.object({
  ...messageFields, attachments: v.array(attachmentSchema), bcc: v.optional(v.array(v.string())), cc: v.optional(v.array(v.string())),
  headers: v.record(v.string(), v.string()), html: v.optional(v.string()), metadata: v.optional(v.record(v.string(), v.string())),
  preheader: v.optional(v.string()), replyTo: v.optional(v.array(v.string())), scheduledAt: v.optional(v.string()), stream: v.optional(v.string()),
  tags: v.optional(v.array(v.object({ name: v.string(), value: v.string() }))), template: v.optional(v.string()), text: v.optional(v.string()),
})
const nonnegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0))
const resultSchemas = {
  list: v.object({ limit: v.nullable(v.pipe(v.number(), v.finite())), messages: v.array(v.object({ ...messageFields, attachments: nonnegativeInteger })) }),
  get: v.object({ message: outboxMessageSchema }),
  clear: v.object({ cleared: nonnegativeInteger }),
}

type OutboxResult =
  | { operation: "list", value: EmailOutboxList }
  | { operation: "get", value: { message: EmailOutboxMessage } }
  | { operation: "clear", value: { cleared: number } }

function parseOutboxResult(operation: EmailDevOperation, value: unknown): OutboxResult | undefined {
  switch (operation) {
    case "list": { const parsed = v.safeParse(resultSchemas.list, value); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "get": { const parsed = v.safeParse(resultSchemas.get, value); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "clear": { const parsed = v.safeParse(resultSchemas.clear, value); return parsed.success ? { operation, value: parsed.output } : undefined }
  }
}

async function readFailure(response: Response): Promise<{ code?: string, message: string }> {
  const text = await response.text()
  try {
    const body: unknown = JSON.parse(text)
    const parsed = v.safeParse(v.object({ error: v.object({ code: v.optional(v.string()), message: v.string() }) }), body)
    if (parsed.success) return parsed.output.error
  }
  catch {
    // Guard rejections use plain text.
  }
  return { message: text || `Email Dev request failed with HTTP ${response.status}.` }
}

function writeFailure(json: boolean, context: EmailCliContext, failure: { code?: string, message: string }): number {
  if (json) context.stdout.write(`${JSON.stringify({ error: failure }, null, 2)}\n`)
  else context.stderr.write(`${failure.message}\n`)
  return 1
}

function withTimeout(timeout: number | undefined): Pick<RequestInit, "signal"> {
  return timeout ? { signal: AbortSignal.timeout(timeout) } : {}
}

function formatOutboxResult(parsed: ParsedOutboxArgs, result: OutboxResult): string {
  if (parsed.json) return `${JSON.stringify(result.operation === "get" ? result.value.message : result.value, null, 2)}\n`
  switch (result.operation) {
    case "list":
      return formatOutboxList(result.value)
    case "get": {
      const message = result.value.message
      if (parsed.format === "html") return message.html === undefined ? "" : `${message.html}\n`
      if (parsed.format === "text") return message.text === undefined ? "" : `${message.text}\n`
      return formatMessage(message)
    }
    case "clear": {
      const cleared = result.value.cleared
      return `Removed ${cleared} message${cleared === 1 ? "" : "s"} from the outbox.\n`
    }
  }
}

async function runOutboxCommand(command: OutboxCommand, args: string[], context: EmailCliContext, options: EmailCliOptions): Promise<number> {
  let parsed: ParsedOutboxArgs
  try {
    parsed = parseOutboxArgs(command, args, context.env)
  }
  catch (error) {
    const terminator = args.indexOf("--")
    if (args.slice(0, terminator < 0 ? args.length : terminator).includes("--json")) return writeFailure(true, context, { message: error instanceof Error ? error.message : String(error) })
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    writeOutboxUsage(command, context.stderr)
    return 1
  }
  if (parsed.help) {
    writeOutboxUsage(command, context.stdout)
    return 0
  }
  const fetchImpl = options.fetch ?? globalThis.fetch
  let discoveryError = ""
  const server = await discoverViteHubDevServer<EmailDevDiscovery>({
    endpoint: emailDevEndpoint,
    fetch: fetchImpl,
    rootDir: context.rootDir,
    parseDiscovery: parseEmailDevDiscovery,
    serverUrl: parsed.url,
    signal: withTimeout(parsed.timeout).signal ?? undefined,
    stderr: parsed.json ? { write: (chunk) => { discoveryError += chunk; return true } } : context.stderr,
  })
  if (!server) {
    if (parsed.json) return writeFailure(true, context, { message: `${discoveryError.trim()} ${emailDevServerHint}` })
    context.stderr.write(`${emailDevServerHint}\n`)
    return 1
  }
  if (server.discovery.runtime !== "nitro") {
    return writeFailure(parsed.json, context, {
      code: "EMAIL_DEV_RUNTIME_UNAVAILABLE",
      message: v.is(v.string(), server.discovery.message)
        ? server.discovery.message
        : "This Vite Development Server cannot reach the Email outbox.",
    })
  }
  const body: EmailDevRequestBody = parsed.id === undefined
    ? { operation: command.operation }
    : { id: parsed.id, operation: command.operation }
  let response: Response
  try {
    response = await fetchViteHubDevEndpoint(fetchImpl, server.url, emailDevEndpoint, {
      body: JSON.stringify(body),
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      ...withTimeout(parsed.timeout),
    })
  }
  catch (error) {
    return writeFailure(parsed.json, context, { message: `Email Dev request failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (!response.ok) return writeFailure(parsed.json, context, await readFailure(response))
  const result = parseOutboxResult(command.operation, await response.json().catch(() => undefined))
  if (!result) return writeFailure(parsed.json, context, { message: "The Email Dev response is invalid." })
  context.stdout.write(formatOutboxResult(parsed, result))
  return 0
}

/**
 * Runs one `vitehub email outbox` command against a running Vite + Nitro Development Server.
 * `args[0]` is the command name: `list`, `show`, or `clear`.
 */
export async function runEmailOutboxCli(args: string[], context: EmailCliContext, options: EmailCliOptions = {}): Promise<number> {
  const [name, ...rest] = args
  if (!name || name === "-h" || name === "--help") {
    writeOutboxCommands(name ? context.stdout : context.stderr)
    return name ? 0 : 1
  }
  const command = outboxCommands.find(entry => entry.name === name)
  if (!command) {
    const terminator = args.indexOf("--")
    if (args.slice(0, terminator < 0 ? args.length : terminator).includes("--json")) return writeFailure(true, context, { message: `Unknown outbox command: ${name}` })
    context.stderr.write(`Unknown outbox command: ${name}\n`)
    writeOutboxCommands(context.stderr)
    return 1
  }
  return await runOutboxCommand(command, rest, context, options)
}

interface ParsedPreviewArgs {
  data?: string
  format?: OutboxBodyFormat
  help: boolean
  template?: string
}

function parsePreviewArgs(args: readonly string[]): ParsedPreviewArgs {
  const parsed: ParsedPreviewArgs = { help: false }
  const setPreviewFormat = (format: OutboxBodyFormat) => {
    if (parsed.format && parsed.format !== format) throw usageError("Use only one of --html, --text, and --json.")
    parsed.format = format
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--html") setPreviewFormat("html")
    else if (arg === "--text") setPreviewFormat("text")
    else if (arg === "--json") setPreviewFormat("json")
    else if (arg === "--data") {
      const value = args[index + 1]
      if (value === undefined) throw usageError("Missing value for --data.")
      parsed.data = value
      index += 1
    }
    else if (arg.startsWith("--data=")) parsed.data = arg.slice("--data=".length)
    else if (arg.startsWith("-")) throw usageError(`Unknown option: ${arg}.`)
    else if (parsed.template === undefined) parsed.template = arg
    else throw usageError(`Unexpected argument: ${arg}.`)
  }
  if (!parsed.help && !parsed.template) throw usageError("Missing template name.")
  return parsed
}

function writePreviewUsage(stream: ViteHubCliStreams["stdout"]): void {
  stream.write([
    `Usage: ${previewUsage}`,
    "",
    "Render an Email template from server/emails without sending it. The command does not need a running server.",
    "",
    "Options:",
    "  --data <json|@file>  Template data as a JSON object, or @ and a JSON file path.",
    "  --html               Print only the rendered HTML.",
    "  --text               Print only the text body.",
    "  --json               Print JSON with template, file, html, and text.",
    "  -h, --help           Show this help.",
    "",
  ].join("\n"))
}

async function readPreviewData(value: string | undefined, cwd: string): Promise<Record<string, unknown>> {
  if (value === undefined) return {}
  let source = value
  if (value.startsWith("@")) {
    const file = resolve(cwd, value.slice(1))
    try {
      source = await readFile(file, "utf8")
    }
    catch {
      throw emailErrorDiagnostics.EMAIL_CLI_USAGE({ problem: `Cannot read --data file ${JSON.stringify(value.slice(1))}.` })
    }
  }
  let data: unknown
  try {
    data = JSON.parse(source)
  }
  catch {
    throw emailErrorDiagnostics.EMAIL_CLI_USAGE({ problem: "--data must be valid JSON." })
  }
  if (!isRecord(data)) throw emailErrorDiagnostics.EMAIL_CLI_USAGE({ problem: "--data must be a JSON object." })
  return data
}

/**
 * Renders one Email template with `renderEmailMarkdown()` and prints it. The template name is the path under
 * `server/emails` without `.md`, the same name as the `#vitehub/emails/<name>` import.
 */
export async function runEmailPreviewCli(args: string[], context: EmailCliContext, options: EmailCliOptions = {}): Promise<number> {
  let parsed: ParsedPreviewArgs
  try {
    parsed = parsePreviewArgs(args)
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    writePreviewUsage(context.stderr)
    return 1
  }
  if (parsed.help) {
    writePreviewUsage(context.stdout)
    return 0
  }
  const json = parsed.format === "json"
  const roots = options.templateRoots?.() ?? [resolve(context.rootDir, "server", "emails")]
  try {
    const templates = await discoverEmailTemplates([...roots])
    const template = templates.find(entry => entry.name === parsed.template)
    if (!template) {
      const available = templates.map(entry => entry.name)
      return writeFailure(json, context, {
        code: "EMAIL_TEMPLATE_NOT_FOUND",
        message: `Email template ${JSON.stringify(parsed.template)} was not found in ${roots.map(root => relative(context.rootDir, root) || ".").join(", ")}. ${available.length ? `Templates: ${available.join(", ")}.` : "No templates were found."}`,
      })
    }
    const data = await readPreviewData(parsed.data, context.cwd)
    const rendered = await renderEmailMarkdown(await readFile(template.file, "utf8"), { data })
    const file = relative(context.rootDir, template.file)
    if (parsed.format === "html") context.stdout.write(`${rendered.html}\n`)
    else if (parsed.format === "text") context.stdout.write(`${rendered.text}\n`)
    else if (json) context.stdout.write(`${JSON.stringify({ file, html: rendered.html, template: template.name, text: rendered.text }, null, 2)}\n`)
    else context.stdout.write([`Template: ${template.name}`, `File: ${file}`, "", "Text:", rendered.text, "", "HTML:", rendered.html, ""].join("\n"))
    return 0
  }
  catch (error) {
    return writeFailure(json, context, { message: error instanceof Error ? error.message : String(error) })
  }
}

export function createEmailCliContributor(options: EmailCliOptions = {}): ViteHubCliContributor {
  return {
    namespaces: [{
      description: "Inspect the development outbox and preview Email templates.",
      features: [
        {
          description: "List, show, or clear messages that the development outbox captured.",
          name: "outbox",
          run: async (args: string[], context: ViteHubCliContext) => await runEmailOutboxCli(args, context, options),
          usage: outboxUsage,
        },
        {
          description: "Render an Email template without sending it.",
          name: "preview",
          run: async (args: string[], context: ViteHubCliContext) => await runEmailPreviewCli(args, context, options),
          usage: previewUsage,
        },
      ],
      name: "email",
    }],
  }
}
