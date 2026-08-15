import { createHmac } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import { deployedChannelWebhookUrl, loadChannelTargets, type LoadedChannelTarget } from "./channel-sync-cli.ts"

interface ChannelHistoryCliContext {
  cwd: string
  env: NodeJS.ProcessEnv
  rootDir: string
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface ChannelHistoryCliOptions {
  fetch?: typeof fetch
  loadTargets?: (input: { agent?: string, channel?: string, env: NodeJS.ProcessEnv, rootDir: string, stage: string }) => Promise<LoadedChannelTarget[]>
  rootDir?: string
}

interface ParsedChannelHistoryArgs {
  agent?: string
  channel?: string
  help: boolean
  origin?: string
  output?: string
  stage?: string
  threadId?: string
}

const channelHistoryHeader = "x-vitehub-channel-history"

function writeUsage(context: ChannelHistoryCliContext): void {
  context.stdout.write([
    "Usage: vitehub channels history --stage <name> --url <https-origin> --output <directory> [--agent <name>] [--channel <id>] [--thread <id>]",
    "",
    "Download one deployed Channel conversation and its attachments.",
    "Telegram direct messages infer the thread when exactly one user is allowed; other conversations require --thread.",
    "",
  ].join("\n"))
}

function parseArgs(args: string[]): ParsedChannelHistoryArgs {
  const parsed: ParsedChannelHistoryArgs = { help: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") parsed.help = true
    else if (["--agent", "--channel", "--output", "--stage", "--thread", "--url"].includes(arg)) {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw new TypeError(`${arg} requires a value.`)
      if (arg === "--agent") parsed.agent = value
      else if (arg === "--channel") parsed.channel = value
      else if (arg === "--output") parsed.output = value
      else if (arg === "--stage") parsed.stage = value
      else if (arg === "--thread") parsed.threadId = value
      else parsed.origin = value
    }
    else throw new TypeError(`Unknown channels history option: ${arg}`)
  }
  return parsed
}

function normalizedOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new TypeError("--url must be an HTTPS origin without credentials, a path, query, or fragment.")
  }
  return url.origin
}

function historyHeaders(target: LoadedChannelTarget, body: string): Headers {
  const registration = target.registration
  if (!registration?.secretHeader || !registration.secretToken) {
    throw new Error(`Channel ${target.agent}/${target.channel} needs a configured webhook secret before history can be exported.`)
  }
  const value = registration.signature === "github-sha256"
    ? `sha256=${createHmac("sha256", registration.secretToken).update(body).digest("hex")}`
    : registration.secretToken
  return new Headers({
    "content-type": "application/json",
    [channelHistoryHeader]: "1",
    [registration.secretHeader]: value,
  })
}

function safeAttachmentName(name: unknown, mimeType: unknown, index: number): string {
  const fallbackExtension = typeof mimeType === "string" ? ({
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  } as Record<string, string>)[mimeType] || "" : ""
  const source = typeof name === "string" && name.trim() ? basename(name.trim()) : `attachment-${index}${fallbackExtension}`
  return source.replace(/[^A-Za-z0-9._-]+/g, "-") || `attachment-${index}`
}

async function materializeAttachments(value: unknown, mediaDir: string, counter: { value: number }): Promise<unknown> {
  if (Array.isArray(value)) return await Promise.all(value.map(item => materializeAttachments(item, mediaDir, counter)))
  if (!value || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  if (typeof record.data === "string" && (typeof record.type === "string" || typeof record.mimeType === "string")) {
    counter.value += 1
    const fileName = `${String(counter.value).padStart(4, "0")}-${safeAttachmentName(record.name, record.mimeType, counter.value)}`
    await mkdir(mediaDir, { recursive: true })
    await writeFile(join(mediaDir, fileName), Buffer.from(record.data, "base64"))
    const { data: _data, ...attachment } = record
    return { ...attachment, file: `media/${fileName}` }
  }
  return Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, item]) => [key, await materializeAttachments(item, mediaDir, counter)])))
}

export async function runAgentChannelHistoryCli(
  args: string[],
  context: ChannelHistoryCliContext,
  options: ChannelHistoryCliOptions = {},
): Promise<number> {
  try {
    const parsed = parseArgs(args)
    if (parsed.help) {
      writeUsage(context)
      return 0
    }
    if (!parsed.stage) throw new TypeError("channels history requires --stage <name>.")
    if (!parsed.origin) throw new TypeError("channels history requires --url <https-origin>.")
    if (!parsed.output) throw new TypeError("channels history requires --output <directory>.")
    const targets = await (options.loadTargets || loadChannelTargets)({
      agent: parsed.agent,
      channel: parsed.channel,
      env: context.env,
      rootDir: options.rootDir || context.rootDir,
      stage: parsed.stage,
    })
    if (targets.length !== 1) throw new Error(`channels history requires exactly one matching Channel; found ${targets.length}.`)
    const target = targets[0]!
    const threadId = parsed.threadId || target.defaultThreadId
    if (!threadId) throw new Error(`Channel ${target.agent}/${target.channel} requires --thread <id>.`)
    const url = deployedChannelWebhookUrl(target, normalizedOrigin(parsed.origin))
    if (!url) throw new Error(`Channel ${target.agent}/${target.channel} has no deployed webhook route.`)
    const body = JSON.stringify({ threadId })
    const response = await (options.fetch || globalThis.fetch)(url, {
      body,
      headers: historyHeaders(target, body),
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(`Channel history export failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}.`)
    }
    const history = await response.json()
    const outputDir = resolve(context.cwd, parsed.output)
    await mkdir(dirname(outputDir), { recursive: true })
    await mkdir(outputDir)
    const materialized = await materializeAttachments(history, join(outputDir, "media"), { value: 0 })
    await writeFile(join(outputDir, "history.json"), `${JSON.stringify(materialized, null, 2)}\n`)
    const messageCount = Array.isArray((materialized as { messages?: unknown }).messages) ? (materialized as { messages: unknown[] }).messages.length : 0
    context.stdout.write(`Downloaded ${messageCount} messages to ${outputDir}\n`)
    return 0
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
