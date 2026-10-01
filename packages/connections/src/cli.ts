import * as v from "valibot"

import type { ViteHubCliContext, ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ConnectionActivity, ConnectionSummary } from "./types.ts"

const usage = [
  "Usage: vitehub connections <command> [name] [--url <url>]",
  "",
  "Inspect and manage Connections through a running development server with the Console.",
  "",
  "Commands:",
  "  list                 List Connections and their status.",
  "  status <name>        Show one Connection.",
  "  activity [name]      Show recent activity.",
  "  connect <name>       Print a single-use connect URL. Open it in a browser.",
  "  refresh <name>       Refresh the access token now.",
  "  disconnect <name>    Revoke the grant at the provider and delete it.",
  "",
  "Options:",
  "  --url <url>          Development server URL. Defaults to VITEHUB_DEV_SERVER_URL or http://localhost:5173.",
  "",
].join("\n")

function parse(args: string[], env: NodeJS.ProcessEnv): { help: boolean, name?: string, url: string } {
  const parsed: { help: boolean, name?: string, url: string } = { help: false, url: env.VITEHUB_DEV_SERVER_URL || "http://localhost:5173" }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "-h" || arg === "--help") parsed.help = true
    else if (arg === "--url" || arg === "--server") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) throw new TypeError(`Missing value for ${arg}.`)
      parsed.url = value
      index += 1
    }
    else if (arg.startsWith("--url=")) parsed.url = arg.slice("--url=".length)
    else if (arg.startsWith("-")) throw new TypeError(`Unknown option: ${arg}.`)
    else if (parsed.name === undefined) parsed.name = arg
    else throw new TypeError(`Unexpected argument: ${arg}.`)
  }
  return parsed
}

const optionalString = v.fallback(v.optional(v.string()), undefined)
const errorBody = v.object({ code: optionalString, message: optionalString })
const resultBody = v.record(v.string(), v.unknown())

async function manage(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = new URL(url)
  const response = await fetch(new URL("/_vitehub/connections/manage", base), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "origin": base.origin },
    method: "POST",
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = v.safeParse(errorBody, value)
    const code = error.success && error.output.code ? `${error.output.code}: ` : ""
    const message = error.success && error.output.message ? error.output.message : `Request failed with ${response.status}.`
    throw new Error(`${code}${message}`)
  }
  return v.parse(resultBody, value)
}

function line(connection: ConnectionSummary): string {
  return [
    connection.name.padEnd(20),
    connection.provider.padEnd(10),
    connection.status.padEnd(16),
    connection.account ?? "-",
    connection.expiresAt ? `expires ${connection.expiresAt}` : "",
  ].join(" ").trimEnd()
}

function activityLine(event: ConnectionActivity): string {
  return [
    event.timestamp,
    event.connection,
    `${event.actor.kind}:${event.actor.id}`,
    event.action,
    event.operation ?? "",
    event.outcome,
    event.status ?? "",
    event.durationMs === undefined ? "" : `${event.durationMs}ms`,
  ].filter(value => value !== "").join("  ")
}

function command(
  name: string,
  description: string,
  run: (parsed: { name?: string, url: string }, context: ViteHubCliContext) => Promise<void>,
  requiresName = true,
) {
  return {
    description,
    name,
    usage,
    async run(args: string[], context: ViteHubCliContext): Promise<number> {
      try {
        const parsed = parse(args, context.env)
        if (parsed.help) {
          context.stdout.write(usage)
          return 0
        }
        if (requiresName && !parsed.name) throw new TypeError(`vitehub connections ${name} requires a Connection name.`)
        await run(parsed, context)
        return 0
      }
      catch (error) {
        context.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        return 1
      }
    },
  }
}

/** CLI commands for Connections. They call the Console management route of a development server. */
export function createConnectionsCliContributor(): ViteHubCliContributor {
  return {
    namespaces: [{
      description: "Inspect and manage Connections.",
      features: [
        command("list", "List Connections.", async ({ url }, context) => {
          const result = await manage(url, { action: "list" })
          // SAFETY: The management route returns ConnectionSummary values for the list action.
          for (const connection of result.connections as ConnectionSummary[]) context.stdout.write(`${line(connection)}\n`)
        }, false),
        command("status", "Show one Connection.", async ({ name, url }, context) => {
          const result = await manage(url, { action: "inspect", name })
          context.stdout.write(`${JSON.stringify(result.connection, null, 2)}\n`)
        }),
        command("activity", "Show recent activity.", async ({ name, url }, context) => {
          const result = await manage(url, { action: "activity", ...(name ? { name } : {}) })
          // SAFETY: The management route returns ConnectionActivity values for the activity action.
          for (const event of result.events as ConnectionActivity[]) context.stdout.write(`${activityLine(event)}\n`)
        }, false),
        command("connect", "Print a connect URL.", async ({ name, url }, context) => {
          const result = await manage(url, { action: "start", name })
          context.stdout.write(`Open this URL in a browser before ${String(result.expiresAt)}:\n${String(result.url)}\n`)
        }),
        command("refresh", "Refresh the access token.", async ({ name, url }, context) => {
          const result = await manage(url, { action: "refresh", name })
          // SAFETY: The management route returns a ConnectionSummary for the refresh action.
          context.stdout.write(`${line(result.connection as ConnectionSummary)}\n`)
        }),
        command("disconnect", "Revoke and delete the grant.", async ({ name, url }, context) => {
          const result = await manage(url, { action: "disconnect", name })
          // SAFETY: The management route returns a ConnectionSummary for the disconnect action.
          context.stdout.write(`${line(result.connection as ConnectionSummary)}\n`)
        }),
      ],
      name: "connections",
    }],
  }
}
