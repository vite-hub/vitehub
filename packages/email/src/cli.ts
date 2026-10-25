import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import * as v from "valibot"

import { readViteHubDevTargetOption } from "@vite-hub/internal/cli"
import { callOperationFromCli } from "@vite-hub/internal/operations"

import { emailErrorDiagnostics } from "./error-diagnostics.ts"
import { previewEmailTemplate } from "./preview.ts"

import type { ViteHubCliContext, ViteHubCliContributor, ViteHubCliStreams } from "@vite-hub/internal/cli"
import type { EmailOutboxDelivery, EmailOutboxList, EmailOutboxMessage } from "./runtime/console.ts"

export type EmailCliContext = Pick<ViteHubCliContext, "cwd" | "env" | "fetch" | "rootDir"> & ViteHubCliStreams

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
  url?: string
}

interface OutboxCommand {
  description: string
  formats?: boolean
  id?: boolean
  name: "clear" | "list" | "show"
  operation: "outbox-clear" | "outbox-list" | "outbox-show"
}

const usageError = (message: string) => emailErrorDiagnostics.EMAIL_CLI_USAGE({ problem: message })

const emailDevTargetErrors = {
  invalidInlineTimeout: usageError,
  invalidTimeout: usageError,
  missingValue: usageError,
}

const outboxCommands: readonly OutboxCommand[] = [
  { description: "List captured messages, newest first.", name: "list", operation: "outbox-list" },
  { description: "Show one captured message.", formats: true, id: true, name: "show", operation: "outbox-show" },
  { description: "Remove every captured message.", name: "clear", operation: "outbox-clear" },
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
    "The command runs the email operation of the app: on the dev server of this project, or on a deployed app with --url.",
    "",
    "Options:",
    ...(command.formats
      ? [
          "  --html            Print only the HTML source.",
          "  --text            Print only the text body.",
        ]
      : []),
    "  --json            Print JSON.",
    "  --url <url>       Deployed app URL. Credentials come from VITEHUB_CONSOLE_AUTHORIZATION, VITEHUB_CONSOLE_COOKIE, or CF_ACCESS_*. Defaults to the dev server of this project.",
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

function parseOutboxArgs(command: OutboxCommand, args: readonly string[]): ParsedOutboxArgs {
  const parsed: ParsedOutboxArgs = { help: false, json: false }
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
  | { operation: "outbox-list", value: EmailOutboxList }
  | { operation: "outbox-show", value: { message: EmailOutboxMessage } }
  | { operation: "outbox-clear", value: { cleared: number } }

function parseOutboxResult(operation: OutboxCommand["operation"], value: unknown): OutboxResult | undefined {
  switch (operation) {
    case "outbox-list": { const parsed = v.safeParse(resultSchemas.list, value); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "outbox-show": { const parsed = v.safeParse(resultSchemas.get, value); return parsed.success ? { operation, value: parsed.output } : undefined }
    case "outbox-clear": { const parsed = v.safeParse(resultSchemas.clear, value); return parsed.success ? { operation, value: parsed.output } : undefined }
  }
}

function writeFailure(json: boolean, context: EmailCliContext, failure: { code?: string, fix?: string, message: string }): number {
  if (json) context.stdout.write(`${JSON.stringify({ error: failure }, null, 2)}\n`)
  else context.stderr.write(`${failure.message}${failure.fix ? `\n${failure.fix}` : ""}\n`)
  return 1
}

function formatOutboxResult(parsed: ParsedOutboxArgs, result: OutboxResult): string {
  if (parsed.json) return `${JSON.stringify(result.operation === "outbox-show" ? result.value.message : result.value, null, 2)}\n`
  switch (result.operation) {
    case "outbox-list":
      return formatOutboxList(result.value)
    case "outbox-show": {
      const message = result.value.message
      if (parsed.format === "html") return message.html === undefined ? "" : `${message.html}\n`
      if (parsed.format === "text") return message.text === undefined ? "" : `${message.text}\n`
      return formatMessage(message)
    }
    case "outbox-clear": {
      const cleared = result.value.cleared
      return `Removed ${cleared} message${cleared === 1 ? "" : "s"} from the outbox.\n`
    }
  }
}

async function runOutboxCommand(command: OutboxCommand, args: string[], context: EmailCliContext, options: EmailCliOptions): Promise<number> {
  let parsed: ParsedOutboxArgs
  try {
    parsed = parseOutboxArgs(command, args)
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
  const called = await callOperationFromCli({
    env: context.env,
    fetch: context.fetch ?? options.fetch ?? globalThis.fetch,
    rootDir: context.rootDir,
    ...(parsed.timeout ? { timeout: parsed.timeout } : {}),
    ...(parsed.url ? { url: parsed.url } : {}),
  }, `email.${command.operation}`, parsed.id === undefined ? {} : { id: parsed.id })
  if (!called.ok) return writeFailure(parsed.json, context, { code: called.code, message: called.message, ...(called.fix ? { fix: called.fix } : {}) })
  const result = parseOutboxResult(command.operation, called.value)
  if (!result) return writeFailure(parsed.json, context, { message: "The email operation answered with an invalid result." })
  context.stdout.write(formatOutboxResult(parsed, result))
  return 0
}

/**
 * Runs one `vitehub email outbox` command through the `email.outbox-*` operations, on the dev server of this project or
 * on a deployed app with `--url`.
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
    const rendered = await previewEmailTemplate(roots, context.rootDir, parsed.template!, await readPreviewData(parsed.data, context.cwd))
    if (parsed.format === "html") context.stdout.write(`${rendered.html}\n`)
    else if (parsed.format === "text") context.stdout.write(`${rendered.text}\n`)
    else if (json) context.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`)
    else context.stdout.write([`Template: ${rendered.template}`, `File: ${rendered.file}`, "", "Text:", rendered.text, "", "HTML:", rendered.html, ""].join("\n"))
    return 0
  }
  catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
    return writeFailure(json, context, { ...(code ? { code } : {}), message: error instanceof Error ? error.message : String(error) })
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
