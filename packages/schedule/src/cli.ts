import { scheduleErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliContext, ViteHubCliContributor } from "@vite-hub/internal/cli"

/** Development Server route that runs a Static Schedule Definition for `vitehub schedule run`. */
export const scheduleDevRunRoute = "/__vitehub/schedule/run"
/** Header that marks a Development Server request as a CLI request, so browsers cannot send it cross-site. */
export const scheduleDevRunHeader = "x-vitehub-schedule-run"
/** Console route that runs a Static Schedule Definition on a deployment. */
export const scheduleConsoleRunRoute = "_vitehub/schedules/run"

interface ParsedScheduleRunArgs {
  help: boolean
  json: boolean
  name?: string
  server?: string
  url?: string
}

interface ScheduleRunTarget {
  headers: Headers
  remote: boolean
  url: string
}

const usage = "vitehub schedule run <name> [--url <console-url>] [--server <dev-server-url>] [--json]"

function cliError(message: string): Error {
  return scheduleErrorDiagnostics.SCHEDULE_R0036({ message })
}

function writeUsage(context: Pick<ViteHubCliContext, "stdout">): void {
  context.stdout.write([
    `Usage: ${usage}`,
    "",
    "Run a Static Schedule Definition now. The definition must set manual: true.",
    "Without --url, the command uses the running Vite Development Server.",
    "",
    "Options:",
    "  --url <url>     Deployed Console URL. Requires console.invoke. Set VITEHUB_CONSOLE_AUTHORIZATION or VITEHUB_CONSOLE_COOKIE to authenticate.",
    "  --server <url>  Vite Development Server URL. Defaults to VITEHUB_DEV_SERVER_URL or http://localhost:5173.",
    "  --json          Print the run as JSON.",
    "  -h, --help      Show this help.",
    "",
  ].join("\n"))
}

export function parseScheduleRunArgs(args: string[]): ParsedScheduleRunArgs {
  const parsed: ParsedScheduleRunArgs = { help: false, json: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") {
      parsed.help = true
      continue
    }
    if (arg === "--json") {
      parsed.json = true
      continue
    }
    if (arg.startsWith("--")) {
      const separator = arg.indexOf("=")
      const option = separator === -1 ? arg : arg.slice(0, separator)
      if (option !== "--url" && option !== "--server") throw cliError(`Unknown schedule run option: ${option}`)
      const value = separator === -1 ? args[++index] : arg.slice(separator + 1)
      if (!value || value.startsWith("--")) throw cliError(`${option} requires a value.`)
      if (option === "--url") parsed.url = value
      else parsed.server = value
      continue
    }
    if (parsed.name) throw cliError(`Unexpected schedule run argument: ${arg}`)
    parsed.name = arg
  }
  return parsed
}

function baseUrl(value: string, label: string): URL {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw cliError(`${label} must be a URL.`)
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw cliError(`${label} must use HTTPS, except for localhost.`)
  if (url.username || url.password || url.search || url.hash) throw cliError(`${label} must not contain credentials, a query, or a fragment.`)
  return url
}

function runTarget(parsed: ParsedScheduleRunArgs, env: NodeJS.ProcessEnv): ScheduleRunTarget {
  const headers = new Headers({ accept: "application/json", "content-type": "application/json" })
  if (parsed.url) {
    const base = baseUrl(parsed.url, "--url")
    if (env.VITEHUB_CONSOLE_AUTHORIZATION) headers.set("authorization", env.VITEHUB_CONSOLE_AUTHORIZATION)
    if (env.VITEHUB_CONSOLE_COOKIE) headers.set("cookie", env.VITEHUB_CONSOLE_COOKIE)
    return {
      headers,
      remote: true,
      url: new URL(scheduleConsoleRunRoute, base.href.endsWith("/") ? base.href : `${base.href}/`).href,
    }
  }
  const server = baseUrl(parsed.server || env.VITEHUB_DEV_SERVER_URL || "http://localhost:5173", "--server")
  headers.set(scheduleDevRunHeader, "1")
  return { headers, remote: false, url: new URL(scheduleDevRunRoute, server).href }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key]
  return typeof field === "string" ? field : undefined
}

function formatDuration(run: Record<string, unknown>): string | undefined {
  const startedAt = Date.parse(stringField(run, "startedAt") ?? "")
  const completedAt = Date.parse(stringField(run, "completedAt") ?? "")
  if (Number.isNaN(startedAt) || Number.isNaN(completedAt)) return
  const milliseconds = Math.max(0, completedAt - startedAt)
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`
}

async function sendRun(target: ScheduleRunTarget, name: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetchImpl(target.url, {
      body: JSON.stringify({ name }),
      headers: target.headers,
      method: "POST",
      redirect: "manual",
    })
  }
  catch {
    throw cliError(target.remote ? `Schedule run request to ${target.url} failed.` : `No Vite Development Server with Schedule found at ${new URL(target.url).origin}.`)
  }
  if (target.remote && (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400))) {
    const text = response.status === 403 ? await response.text() : ""
    const message = stringField(record(parseJSON(text)), "message")
    throw cliError(message ?? `Console authentication failed with HTTP ${response.status}. Set VITEHUB_CONSOLE_AUTHORIZATION or VITEHUB_CONSOLE_COOKIE.`)
  }
  const text = await response.text()
  const json = record(parseJSON(text))
  if (!response.ok) {
    const message = stringField(json, "message") ?? text.slice(0, 500)
    throw cliError(`Schedule run failed with HTTP ${response.status}${message ? `: ${message}` : "."}`)
  }
  const run = record(json?.run)
  if (!run) throw cliError("Schedule run returned an invalid response.")
  return run
}

function parseJSON(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined
  }
  catch {
    return undefined
  }
}

export async function runScheduleRunCli(
  args: string[],
  context: Pick<ViteHubCliContext, "env" | "stderr" | "stdout">,
  options: { fetch?: typeof fetch } = {},
): Promise<number> {
  try {
    const parsed = parseScheduleRunArgs(args)
    if (parsed.help) {
      writeUsage(context)
      return 0
    }
    if (!parsed.name) throw cliError("schedule run requires a Schedule Definition name.")
    const run = await sendRun(runTarget(parsed, context.env), parsed.name, options.fetch ?? globalThis.fetch)
    if (parsed.json) {
      context.stdout.write(`${JSON.stringify(run, null, 2)}\n`)
    }
    else {
      const duration = formatDuration(run)
      const error = stringField(record(run.error), "message")
      const line = `${String(run.status)} ${parsed.name}${duration ? ` in ${duration}` : ""}${error ? `: ${error}` : ""}\n`
      context.stdout.write(line)
      context.stdout.write(`Run ${String(run.id)}\n`)
    }
    return run.status === "succeeded" ? 0 : 1
  }
  catch (error) {
    context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

export function createScheduleCliContributor(): ViteHubCliContributor {
  return {
    namespaces: [{
      description: "Run Static Schedule Definitions on demand.",
      features: [{
        description: "Run a Static Schedule Definition that sets manual: true.",
        name: "run",
        run: async (args, context) => await runScheduleRunCli(args, context),
        usage,
      }],
      name: "schedule",
    }],
  }
}
