import { createHmac } from "node:crypto"
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"
import { deployedChannelWebhookUrl, loadChannelTargets, type LoadedChannelTarget } from "./channel-sync-cli.ts"
import { agentChannelHistoryHeader } from "./channel-history.ts"
import { agentChannelSyncProviderHeader } from "./channel-sync.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"

interface ChannelHistoryCliContext {
  cwd: string
  env: NodeJS.ProcessEnv
  rootDir: string
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface ChannelHistoryCliOptions {
  fetch?: typeof fetch
  loadTargets?: (input: { agent?: string, channel?: string, env: NodeJS.ProcessEnv, registration?: string, resolveDefaultThread: boolean, rootDir: string, stage: string }) => Promise<LoadedChannelTarget[]>
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
  query: Array<[string, string]>
  invocations: boolean
  webhook?: string
  webhookPath?: string
}

function writeUsage(context: ChannelHistoryCliContext): void {
  context.stdout.write([
    "Usage: vitehub channels history --stage <name> --url <https-origin> --output <directory> [--agent <name>] [--channel <id>] [--webhook <id>] [--webhook-path <path>] [--thread <id>] [--query <key=value>]... [--invocations]",
    "",
    "Export deployed Channel history or a conversation and its attachments.",
    "Custom history accepts optional --thread and --query filters. Chat SDK conversations require --thread unless Telegram can infer one allowed user.",
    "",
  ].join("\n"))
}

function parseArgs(args: string[]): ParsedChannelHistoryArgs {
  const parsed: ParsedChannelHistoryArgs = { help: false, invocations: false, query: [] }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--invocations") parsed.invocations = true
    else if (arg === "--query") {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw agentDiagnostics.AGENT_R0521({ message: "--query requires a value." })
      const separator = value.indexOf("=")
      if (separator < 1) throw agentDiagnostics.AGENT_R0521({ message: "--query expects key=value." })
      parsed.query.push([value.slice(0, separator), value.slice(separator + 1)])
    }
    else if (["--agent", "--channel", "--output", "--stage", "--thread", "--url", "--webhook", "--webhook-path"].includes(arg)) {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw agentDiagnostics.AGENT_R0521({ message: `${arg} requires a value.` })
      if (arg === "--agent") parsed.agent = value
      else if (arg === "--channel") parsed.channel = value
      else if (arg === "--output") parsed.output = value
      else if (arg === "--stage") parsed.stage = value
      else if (arg === "--thread") parsed.threadId = value
      else if (arg === "--webhook") parsed.webhook = value
      else if (arg === "--webhook-path") {
        if (!value.startsWith("/") || value.startsWith("//")) throw agentDiagnostics.AGENT_R0521({ message: "--webhook-path expects an absolute deployment path." })
        parsed.webhookPath = value
      }
      else parsed.origin = value
    }
    else throw agentDiagnostics.AGENT_R0522({ message: `Unknown channels history option: ${arg}` })
  }
  return parsed
}

function normalizedOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw agentDiagnostics.AGENT_R0523({ message: "--url must be an HTTPS origin without credentials, a path, query, or fragment." })
  }
  return url.origin
}

function historyHeaders(target: LoadedChannelTarget, body: string): Headers {
  const registration = target.registration
  if (!registration?.secretHeader || !registration.secretToken) {
    throw agentDiagnostics.AGENT_R0524({ message: `Channel ${target.agent}/${target.channel} needs a configured webhook secret before history can be exported.` })
  }
  const secret = registration.secretToken
  const timestamp = Math.floor(Date.now() / 1000)
  const value = registration.signature === "github-sha256"
    ? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
    : registration.signature === "stripe-sha256"
      ? `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`
      : secret
  return new Headers({
    "content-type": "application/json",
    [agentChannelHistoryHeader]: "1",
    [registration.secretHeader]: value,
  })
}

async function verifyHistoryDeployment(url: string, provider: string, fetchImpl: typeof fetch): Promise<void> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
  }
  catch {
    throw agentDiagnostics.AGENT_R0525({ message: "Channel history deployment preflight request failed." })
  }
  if (!response.ok || response.headers.get(agentChannelSyncProviderHeader) !== provider) {
    throw agentDiagnostics.AGENT_R0526({ message: `Channel history deployment preflight failed; expected ${agentChannelSyncProviderHeader}: ${provider}.` })
  }
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

async function materializeAttachment(value: unknown, mediaDir: string, counter: { value: number }): Promise<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (typeof record.data === "string" && (typeof record.type === "string" || typeof record.mimeType === "string")) {
    counter.value += 1
    const fileName = `${String(counter.value).padStart(4, "0")}-${safeAttachmentName(record.name, record.mimeType, counter.value)}`
    await mkdir(mediaDir, { recursive: true })
    await writeFile(join(mediaDir, fileName), Buffer.from(record.data, "base64"))
    const { data: _data, ...attachment } = record
    return { ...attachment, file: `media/${fileName}` }
  }
  return value
}

async function materializeMessage(value: unknown, mediaDir: string, counter: { value: number }): Promise<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const message = value as Record<string, unknown>
  return {
    ...message,
    ...(Array.isArray(message.attachments)
      ? { attachments: await Promise.all(message.attachments.map(item => materializeAttachment(item, mediaDir, counter))) }
      : {}),
    ...(message.replyTo ? { replyTo: await materializeMessage(message.replyTo, mediaDir, counter) } : {}),
  }
}

async function materializeHistory(value: unknown, mediaDir: string, counter: { value: number }): Promise<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const history = value as Record<string, unknown>
  if (!Array.isArray(history.messages)) return value
  return {
    ...history,
    messages: await Promise.all(history.messages.map(message => materializeMessage(message, mediaDir, counter))),
  }
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
    if (!parsed.stage) throw agentDiagnostics.AGENT_R0527({ message: "channels history requires --stage <name>." })
    if (!parsed.origin) throw agentDiagnostics.AGENT_R0528({ message: "channels history requires --url <https-origin>." })
    if (!parsed.output) throw agentDiagnostics.AGENT_R0529({ message: "channels history requires --output <directory>." })
    const targets = await (options.loadTargets || loadChannelTargets)({
      agent: parsed.agent,
      channel: parsed.channel,
      env: context.env,
      registration: parsed.webhook,
      resolveDefaultThread: parsed.threadId === undefined,
      rootDir: options.rootDir || context.rootDir,
      stage: parsed.stage,
    })
    if (targets.length !== 1) throw agentDiagnostics.AGENT_R0530({ message: `channels history requires exactly one matching Channel; found ${targets.length}.` })
    const target = targets[0]!
    const threadId = parsed.threadId || (!target.history ? target.defaultThreadId : undefined)
    if (!target.history && !threadId) throw agentDiagnostics.AGENT_R0531({ message: `Channel ${target.agent}/${target.channel} requires --thread <id>.` })
    const url = deployedChannelWebhookUrl(parsed.webhookPath && target.registration
      ? { ...target, registration: { ...target.registration, path: parsed.webhookPath, url: undefined } }
      : target, normalizedOrigin(parsed.origin))
    if (!url) throw agentDiagnostics.AGENT_R0532({ message: `Channel ${target.agent}/${target.channel} has no deployed webhook route.` })
    const query: Record<string, string | string[]> = {}
    for (const [key, value] of parsed.query) {
      const current = query[key]
      query[key] = current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value]
    }
    const body = JSON.stringify({
      ...(threadId ? { threadId } : {}),
      ...(Object.keys(query).length ? { query } : {}),
      ...(parsed.invocations ? { invocations: true } : {}),
    })
    const outputDir = resolve(context.cwd, parsed.output)
    await mkdir(dirname(outputDir), { recursive: true })
    await access(outputDir).then(
      () => { throw agentDiagnostics.AGENT_R0533({ message: `Channel history output already exists: ${outputDir}` }) },
      () => undefined,
    )
    const stagingDir = await mkdtemp(join(dirname(outputDir), `.${basename(outputDir)}-`))
    try {
      const fetchImpl = options.fetch || globalThis.fetch
      await verifyHistoryDeployment(url, target.provider, fetchImpl)
      const response = await fetchImpl(url, {
        body,
        headers: historyHeaders(target, body),
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        throw agentDiagnostics.AGENT_R0534({ message: `Channel history export failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}.` })
      }
      const history = await response.json()
      const historyRecord = isRuntimeRecord(history) ? history : undefined
      const allItems: unknown[] = Array.isArray(historyRecord?.items) ? [...historyRecord.items] : []
      let cursor = historyRecord?.nextCursor
      const seen = new Set<string>()
      while (hasRuntimeType(cursor, "string") && cursor) {
        if (seen.has(cursor)) throw agentDiagnostics.AGENT_R0534({ message: "Channel history export returned a repeated pagination cursor." })
        seen.add(cursor)
        const nextBody = JSON.stringify({
          ...(threadId ? { threadId } : {}),
          cursor,
          ...(Object.keys(query).length ? { query } : {}),
          ...(parsed.invocations ? { invocations: true } : {}),
        })
        const nextResponse = await fetchImpl(url, {
          body: nextBody,
          headers: historyHeaders(target, nextBody),
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(120_000),
        })
        if (!nextResponse.ok) throw agentDiagnostics.AGENT_R0534({ message: `Channel history export failed with HTTP ${nextResponse.status}.` })
        const next = await nextResponse.json()
        if (!isRuntimeRecord(next) || !Array.isArray(next.items)) throw agentDiagnostics.AGENT_R0534({ message: "Channel history export returned an invalid page." })
        allItems.push(...next.items)
        cursor = next.nextCursor
      }
      const archive = historyRecord && Array.isArray(historyRecord.items)
        ? (() => {
            const { nextCursor: _nextCursor, ...base } = historyRecord
            return { ...base, items: allItems }
          })()
        : history
      const materialized = await materializeHistory(archive, join(stagingDir, "media"), { value: 0 })
      await writeFile(join(stagingDir, "history.json"), `${JSON.stringify(materialized, null, 2)}\n`)
      await rename(stagingDir, outputDir)
      const archiveRecord = isRuntimeRecord(materialized) ? materialized : undefined
      const messageCount = Array.isArray(archiveRecord?.messages) ? archiveRecord.messages.length
        : Array.isArray(archiveRecord?.items) ? archiveRecord.items.length : 0
      context.stdout.write(`Downloaded ${messageCount} messages to ${outputDir}\n`)
      return 0
    }
    catch (error) {
      await rm(stagingDir, { force: true, recursive: true })
      throw error
    }
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
