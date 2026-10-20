import { discoverViteHubDevServer } from "@vite-hub/internal/cli"
import { readViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { resolveViteHubDispatchKey, signViteHubDispatch } from "@vite-hub/internal/dispatch"
import { redactInspectionText } from "@vite-hub/internal/inspect"
import { scheduleDevRunHeader, scheduleDevRunRoute, scheduleConsoleRunRoute, scheduleDevTokenNamespace, scheduleDevTokenServerHeader } from "./dev.ts"

import { scheduleErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"

interface ParsedScheduleRunArgs {
  help: boolean
  json: boolean
  name?: string
  server?: string
  url?: string
  timeout?: number
}

interface ScheduleDevDiscovery {
  root?: unknown
  scheduleDevTokenServerId?: unknown
}

interface ScheduleRunTarget {
  /** Self-asserted actor claim sent with a signed dispatch. */
  actor?: string
  /** Dispatch key that signs a remote run. */
  dispatchKey?: string
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
    "  --url <url>     Deployed app URL. Requires console.invoke. Set VITEHUB_DISPATCH_KEY or VITEHUB_SECRET to sign the run. VITEHUB_CONSOLE_COOKIE, VITEHUB_CONSOLE_AUTHORIZATION, or CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET also work.",
    "  --server <url>  Vite Development Server URL. Defaults to VITEHUB_DEV_SERVER_URL or http://localhost:5173.",
    "  --json          Print the run as JSON.",
    "  --timeout <ms> Request timeout, from 1 to 2147483647 whole milliseconds.",
    "  --             End options before a name that starts with a hyphen.",
    "  -h, --help      Show this help.",
    "",
  ].join("\n"))
}

export function parseScheduleRunArgs(args: string[]): ParsedScheduleRunArgs {
  const parsed: ParsedScheduleRunArgs = { help: false, json: false }
  let positionalOnly = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!positionalOnly && arg === "--") { positionalOnly = true; continue }
    if (positionalOnly) {
      if (parsed.name !== undefined) throw cliError(`Unexpected schedule run argument: ${arg}`)
      parsed.name = arg
      continue
    }
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
      if (option !== "--url" && option !== "--server" && option !== "--timeout") throw cliError(`Unknown schedule run option: ${option}`)
      const value = separator === -1 ? args[++index] : arg.slice(separator + 1)
      if (!value || value.startsWith("--")) throw cliError(`${option} requires a value.`)
      if (option === "--url") parsed.url = value
      else if (option === "--server") parsed.server = value
      else {
        const timeout = Number(value)
        if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) throw cliError("--timeout must be a whole number from 1 to 2147483647 milliseconds.")
        parsed.timeout = timeout
      }
      continue
    }
    if (arg.startsWith("-")) throw cliError(`Unknown schedule run option: ${arg}`)
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
    if (env.CF_ACCESS_CLIENT_ID) headers.set("cf-access-client-id", env.CF_ACCESS_CLIENT_ID)
    if (env.CF_ACCESS_CLIENT_SECRET) headers.set("cf-access-client-secret", env.CF_ACCESS_CLIENT_SECRET)
    return {
      headers,
      remote: true,
      url: new URL(scheduleConsoleRunRoute, base.href.endsWith("/") ? base.href : `${base.href}/`).href,
    }
  }
  const server = baseUrl(parsed.server || env.VITEHUB_DEV_SERVER_URL || "http://localhost:5173", "--server")
  headers.set(scheduleDevRunHeader, "1")
  return { headers, remote: false, url: new URL(scheduleDevRunRoute.slice(1), server.href.endsWith("/") ? server.href : `${server.href}/`).href }
}

function record(value: unknown): Record<string, unknown> | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate untrusted boundary values before use.
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key]
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate untrusted boundary values before use.
  return typeof field === "string" ? field : undefined
}

function formatDuration(run: Record<string, unknown>): string | undefined {
  const startedAt = Date.parse(stringField(run, "startedAt") ?? "")
  const completedAt = Date.parse(stringField(run, "completedAt") ?? "")
  if (Number.isNaN(startedAt) || Number.isNaN(completedAt)) return
  const milliseconds = Math.max(0, completedAt - startedAt)
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`
}

async function sendRun(target: ScheduleRunTarget, name: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ name })
  if (target.dispatchKey) {
    const headers = await signViteHubDispatch({ actor: target.actor, body, key: target.dispatchKey, operation: "schedule.run" })
    for (const [header, value] of Object.entries(headers)) target.headers.set(header, value)
  }
  let response: Response
  try {
    response = await fetchImpl(target.url, {
      body,
      headers: target.headers,
      method: "POST",
      redirect: "manual",
      signal,
    })
  }
  catch {
    throw cliError(target.remote ? `Schedule run request to ${target.url} failed.` : `No Vite Development Server with Schedule found at ${new URL(target.url).origin}.`)
  }
  if (target.remote && (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400))) {
    const text = response.status === 401 || response.status === 403 ? await response.text() : ""
    const message = stringField(record(parseJSON(text)), "message")
    throw cliError(message ?? `Console authentication failed with HTTP ${response.status}. Set VITEHUB_DISPATCH_KEY or VITEHUB_SECRET, VITEHUB_CONSOLE_COOKIE, or CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.`)
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
  context: Pick<ViteHubCliContext, "env" | "stderr" | "stdout"> & Partial<Pick<ViteHubCliContext, "cwd" | "rootDir">>,
  options: { fetch?: typeof fetch } = {},
): Promise<number> {
  let json = args.slice(0, args.indexOf("--") === -1 ? args.length : args.indexOf("--")).includes("--json")
  try {
    const parsed = parseScheduleRunArgs(args)
    json = parsed.json
    if (parsed.help) {
      writeUsage(context)
      return 0
    }
    if (!parsed.name) throw cliError("schedule run requires a Schedule Definition name.")
    const fetchImpl = options.fetch ?? globalThis.fetch
    const target = runTarget(parsed, context.env)
    if (target.remote) {
      target.dispatchKey = await resolveViteHubDispatchKey(context.env)
      target.actor = context.env.VITEHUB_ACTOR || context.env.USER || context.env.USERNAME || undefined
    }
    const signal = parsed.timeout ? AbortSignal.timeout(parsed.timeout) : undefined
    if (!target.remote) {
      let discoveryFailure = ""
      const rootDir = context.rootDir ?? context.cwd ?? process.cwd()
      const parseDiscovery = (value: unknown): ScheduleDevDiscovery => {
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Discovery payloads are parsed at this transport boundary.
        if (!value || typeof value !== "object") return {}
        // SAFETY: The endpoint parser has narrowed the discovery payload to an object before applying the owner contract.
        return value as ScheduleDevDiscovery
      }
      const server = await discoverViteHubDevServer<ScheduleDevDiscovery>({ endpoint: { header: scheduleDevRunHeader, headerValue: "1", route: scheduleDevRunRoute }, fetch: fetchImpl, parseDiscovery, rootDir, serverUrl: baseUrl(parsed.server || context.env.VITEHUB_DEV_SERVER_URL || "http://localhost:5173", "--server").href, signal, stderr: { write: chunk => { discoveryFailure += String(chunk) } } })
      if (!server) throw cliError(discoveryFailure.trim() || "No Compatible Vite Development Server for manual Schedule runs.")
      const serverId = server.discovery.scheduleDevTokenServerId
      const serverRoot = server.discovery.root
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate public discovery fields before selecting a local private credential.
      if (typeof serverId !== "string" || !serverId || serverRoot !== rootDir) throw cliError("The Schedule Dev server did not provide its token scope. Restart the Vite Development Server.")
      const token = await readViteHubDevToken(rootDir, { namespace: scheduleDevTokenNamespace, serverId })
      if (!token) throw cliError("No private Schedule Dev token was found. Run this command on the Development Server host.")
      target.headers.set(viteHubDevTokenHeader, token)
      target.headers.set(scheduleDevTokenServerHeader, serverId)
      target.url = server.url
    }
    const run = await sendRun(target, parsed.name, fetchImpl, signal)
    const error = record(run.error)
    if (error) run.error = { ...(stringField(error, "message") ? { message: redactInspectionText(stringField(error, "message")!) } : {}), ...(stringField(error, "name") ? { name: redactInspectionText(stringField(error, "name")!) } : {}) }
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
    const message = redactInspectionText(error instanceof Error ? error.message : String(error))
    if (json) context.stdout.write(`${JSON.stringify({ error: { message } })}\n`)
    else context.stderr.write(`${message}\n`)
    return 1
  }
}
