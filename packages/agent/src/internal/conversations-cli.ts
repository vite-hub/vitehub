import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { findViteHubDevServerUrl } from "@vite-hub/internal/cli"
import { callOperation } from "@vite-hub/internal/operations"

import { agentDiagnostics } from "../agent-diagnostics.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type { ConversationExport } from "../operations.ts"

const usage = "vitehub conversations export <agent> <channel> <thread> [--format markdown|json] [--output <directory>] [--media | --no-media] [--url <origin>]"

interface Parsed {
  agent?: string
  channel?: string
  format: "json" | "markdown"
  help: boolean
  media?: boolean
  output?: string
  thread?: string
  url?: string
}

/** The absolute path of a file that the server named, or an error when it leaves the directory. The server is not trusted with paths. */
function insideDirectory(directory: string, path: unknown): string {
  const resolved = typeof path === "string" && path && !path.includes("\0") ? resolve(directory, path) : undefined
  const relation = resolved ? relative(directory, resolved) : undefined
  if (!resolved || !relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw agentDiagnostics.AGENT_CONVERSATIONS_MEDIA_PATH_INVALID({ path: JSON.stringify(path) })
  }
  return resolved
}

function parse(args: readonly string[]): Parsed {
  const parsed: Parsed = { format: "markdown", help: false }
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--media") parsed.media = true
    else if (arg === "--no-media") parsed.media = false
    else if (["--agent", "--channel", "--thread", "--format", "--output", "--url"].includes(arg)) {
      const value = args[++index]
      if (!value || value.startsWith("--")) throw agentDiagnostics.AGENT_CONVERSATIONS_ARGUMENTS_INVALID({ problem: `${arg} requires a value.` })
      if (arg === "--format") {
        if (value !== "markdown" && value !== "json") throw agentDiagnostics.AGENT_CONVERSATIONS_ARGUMENTS_INVALID({ problem: "--format must be markdown or json." })
        parsed.format = value
      }
      else parsed[arg.slice(2) as "agent" | "channel" | "output" | "thread" | "url"] = value
    }
    else if (arg.startsWith("--")) throw agentDiagnostics.AGENT_CONVERSATIONS_ARGUMENTS_INVALID({ problem: `Unknown option ${arg}.` })
    else positional.push(arg)
  }
  const [agent, channel, thread, extra] = positional
  if (extra !== undefined) throw agentDiagnostics.AGENT_CONVERSATIONS_ARGUMENTS_INVALID({ problem: `Unexpected argument ${JSON.stringify(extra)}.` })
  if (agent) parsed.agent = agent
  if (channel) parsed.channel = channel
  if (thread) parsed.thread = thread
  return parsed
}

/**
 * `vitehub conversations export`: read a conversation through the `conversations.export`
 * operation of the running dev server or `--url`. Without `--output` it prints the Markdown or JSON, so
 * `vitehub conversations export … > chat.md` works. With `--output <directory>` it writes the file and the attachments
 * in `media/`, as `vitehub channels history` does.
 */
export async function runConversationsExportCli(args: string[], context: Pick<ViteHubCliContext, "cwd" | "env" | "fetch" | "rootDir" | "stderr" | "stdout">): Promise<number> {
  try {
    const parsed = parse(args)
    if (parsed.help) {
      context.stdout.write(`Usage: ${usage}\n\nExport one Channel conversation. Without --output the text goes to stdout and attachments are not included.\n`)
      return 0
    }
    if (!parsed.agent || !parsed.channel || !parsed.thread) throw agentDiagnostics.AGENT_CONVERSATIONS_ARGUMENTS_INVALID({ problem: "An agent, a channel, and a thread are required." })
    const media = parsed.media ?? Boolean(parsed.output)
    if (media && !parsed.output) throw agentDiagnostics.AGENT_CONVERSATIONS_ARGUMENTS_INVALID({ problem: "--media needs --output <directory>, since attachments are files." })
    const target = parsed.url ?? findViteHubDevServerUrl([context.rootDir], context.env)
    if (!target) throw agentDiagnostics.AGENT_CONVERSATIONS_DEV_SERVER_MISSING({ rootDir: context.rootDir })
    const result = await callOperation({ env: context.env, ...(context.fetch ? { fetch: context.fetch } : {}), roots: [context.rootDir], timeout: 120_000, url: target }, "conversations.export", {
      agent: parsed.agent,
      channel: parsed.channel,
      format: parsed.format,
      media,
      thread: parsed.thread,
    })
    if (!result.ok) {
      context.stderr.write([`${result.code}: ${result.message}`, ...(result.fix ? [`Fix: ${result.fix}`] : []), ""].join("\n"))
      return 1
    }
    // SAFETY: The operation returns this shape.
    const exported = result.value as ConversationExport
    if (!parsed.output) {
      context.stdout.write(exported.text)
      if (exported.retention.warning) context.stderr.write(`${exported.retention.warning}\n`)
      return 0
    }
    const directory = resolve(context.cwd, parsed.output)
    await mkdir(dirname(directory), { recursive: true })
    const exists = await access(directory).then(() => true, () => false)
    if (exists) throw agentDiagnostics.AGENT_CONVERSATIONS_OUTPUT_EXISTS({ directory })
    const staging = await mkdtemp(join(dirname(directory), `.${basename(directory)}-`))
    try {
      // Resolve every path first, so a bad one writes nothing.
      const target = insideDirectory(staging, exported.filename)
      const files = exported.media.map(file => ({ bytes: Buffer.from(file.base64, "base64"), path: insideDirectory(staging, file.path) }))
      await writeFile(target, exported.text)
      for (const file of files) {
        await mkdir(dirname(file.path), { recursive: true })
        await writeFile(file.path, file.bytes)
      }
      await rename(staging, directory)
    }
    catch (error) {
      await rm(staging, { force: true, recursive: true })
      throw error
    }
    context.stdout.write(`Wrote ${exported.messageCount} messages and ${exported.media.length} attachments to ${directory}\n`)
    if (exported.retention.warning) context.stderr.write(`${exported.retention.warning}\n`)
    return 0
  }
  catch (error) {
    const fix: unknown = error instanceof Error ? Reflect.get(error, "fix") : undefined
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${typeof fix === "string" ? `Fix: ${fix}\n` : ""}Usage: ${usage}\n`)
    return 1
  }
}

export const conversationsExportUsage = usage
