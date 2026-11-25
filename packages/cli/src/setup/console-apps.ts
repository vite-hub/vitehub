import { parseArgs } from "node:util"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { consoleOrigin, consoleUrlVariable, defaultConsoleUrl, readConsoleCredential } from "./console-auth.ts"
import { setupExitCodes, table, writeSetupError, writeSetupJson } from "./envelope.ts"

import type { ViteHubCliCommand, ViteHubCliContext } from "@vite-hub/internal/cli"

/** An app or a site that a team linked to the Console, as `GET /api/projects` and the `list_apps` MCP tool give it. */
export interface ConsoleApp {
  id: string
  teamId: string
  url: string
  label: string | null
  createdBy: string
  createdAt: number
  /** `null` for a site that is registered for Hosted Comments. */
  publicKey: string | null
  /** The app variable of the link, such as `VITEHUB_CONSOLE_KEY_CONSOLE_1A2B3C4D`. `null` for a site. */
  keyVariable: string | null
}

/** A Console that the CLI calls with the API key of `vitehub login` or `VITEHUB_CONSOLE_TOKEN`. */
export interface ConsoleClient {
  origin: string
  request: (path: string, init?: { body?: unknown, method?: string }) => Promise<{ status: number, body: Record<string, unknown> }>
}

/** The Console of `--console`, else `VITEHUB_CONSOLE_URL`, else the only saved Console, else console.vitehub.dev. */
export async function openConsole(context: Pick<ViteHubCliContext, "env" | "fetch">, console?: string): Promise<ConsoleClient> {
  const credential = await readConsoleCredential(context.env, console)
  if (!credential) throw cliErrorDiagnostics.CLI_CONSOLE_SIGNED_OUT({ console: consoleOrigin(console ?? context.env[consoleUrlVariable] ?? defaultConsoleUrl) })
  return {
    origin: credential.origin,
    async request(path, init = {}) {
      const response = await (context.fetch ?? fetch)(`${credential.origin}${path}`, {
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        headers: { accept: "application/json", authorization: `Bearer ${credential.token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        method: init.method ?? "GET",
      }).catch((error: unknown) => {
        throw cliErrorDiagnostics.CLI_CONSOLE_REQUEST_FAILED({ code: "FETCH_FAILED", console: credential.origin, message: `The Console did not answer ${path}: ${error instanceof Error ? error.message : String(error)}` })
      })
      if (response.status === 401) throw cliErrorDiagnostics.CLI_CONSOLE_SIGNED_OUT({ console: credential.origin })
      const body: unknown = response.status === 204 ? {} : await response.json().catch(() => ({}))
      const record = body instanceof Object ? body as Record<string, unknown> : {}
      if (!response.ok) {
        throw cliErrorDiagnostics.CLI_CONSOLE_REQUEST_FAILED({
          code: typeof record.code === "string" ? record.code : String(response.status),
          console: credential.origin,
          ...(typeof record.fix === "string" ? { fix: record.fix } : {}),
          message: typeof record.message === "string" ? record.message : `${credential.origin} answered ${response.status} to ${path}.`,
        })
      }
      return { body: record, status: response.status }
    },
  }
}

/** The apps of the team of the key. */
export async function listConsoleApps(client: ConsoleClient): Promise<ConsoleApp[]> {
  const { body } = await client.request("/api/projects")
  // SAFETY: `GET /api/projects` answers `{ projects }` with the project rows of the team.
  return Array.isArray(body.projects) ? body.projects as ConsoleApp[] : []
}

/** Link an app, or register a site with `kind: "site"`. Linking a URL again returns the same link with `created: false`. */
export async function linkConsoleApp(client: ConsoleClient, input: { url: string, label?: string, kind?: "site" }): Promise<{ app: ConsoleApp, created: boolean }> {
  const { body, status } = await client.request("/api/projects", { body: input, method: "POST" })
  // SAFETY: A `200` or `201` of `POST /api/projects` has `{ project }`.
  return { app: body.project as ConsoleApp, created: status === 201 }
}

/** What `project.get` of the app answers to a signed request of the Console. `linked` is true when the app knows the key. */
export interface ConsoleAppCheck {
  answer: unknown
  linked: boolean
  status: number
}

export async function checkConsoleApp(client: ConsoleClient, id: string): Promise<ConsoleAppCheck> {
  const { body } = await client.request(`/api/projects/${encodeURIComponent(id)}/check`, { body: {}, method: "POST" })
  return { answer: body.answer, linked: body.linked === true, status: typeof body.status === "number" ? body.status : 0 }
}

/** The Console page of an app. */
export function consoleAppUrl(origin: string, app: Pick<ConsoleApp, "url">): string {
  return `${origin}/open?project=${encodeURIComponent(app.url)}`
}

/** The text of a check that did not link, such as `401 CONSOLE_KEY_UNKNOWN: ...`. */
export function checkProblem(check: ConsoleAppCheck): string {
  const answer = Object(check.answer)
  const code: unknown = Reflect.get(answer, "code")
  const message: unknown = Reflect.get(answer, "message")
  return [check.status ? String(check.status) : "", typeof code === "string" ? code : ""].filter(Boolean).join(" ") + (typeof message === "string" ? `: ${message}` : "")
}

const usage = {
  check: "vitehub apps check <id> [--console <url>] [--json]",
  link: "vitehub apps link <url> [--label <name>] [--kind site] [--console <url>] [--json]",
  list: "vitehub apps list [--console <url>] [--json]",
  unlink: "vitehub apps unlink <id> --delete-hosted-comments [--console <url>] [--json]",
} as const

type AppsCommand = keyof typeof usage

interface AppsValues {
  "console"?: string
  "delete-hosted-comments": boolean
  "help": boolean
  "json": boolean
  "kind"?: string
  "label"?: string
}

function readAppsArgs(command: AppsCommand, args: string[]): { values: AppsValues, positionals: string[] } {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      args,
      options: {
        "console": { type: "string" },
        "help": { default: false, short: "h", type: "boolean" },
        "json": { default: false, type: "boolean" },
        ...(command === "link" ? { kind: { type: "string" as const }, label: { type: "string" as const } } : {}),
        ...(command === "unlink" ? { "delete-hosted-comments": { default: false, type: "boolean" as const } } : {}),
      },
      strict: true,
    })
    const expected = command === "list" ? 0 : 1
    if (!values.help && positionals.length !== expected) throw new Error(expected ? `Pass one ${command === "link" ? "URL" : "app id"}.` : `Got ${JSON.stringify(positionals[0])}.`)
    // SAFETY: The options above, read with `strict: true`.
    return { positionals, values: { "delete-hosted-comments": false, ...values } as AppsValues }
  }
  catch (error: unknown) {
    throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] ${error instanceof Error ? error.message : String(error)} Usage: ${usage[command]}` })
  }
}

function appName(app: ConsoleApp): string {
  return app.label ? `${app.label} (${app.url})` : app.url
}

async function runApps(command: AppsCommand, args: string[], context: ViteHubCliContext): Promise<number> {
  const { positionals, values } = readAppsArgs(command, args)
  if (values.help) {
    context.stdout.write(`Usage: ${usage[command]}\n\n${appsHelp[command]}\n`)
    return setupExitCodes.done
  }
  const client = await openConsole(context, values.console)
  const write = (result: object, text: string) => {
    if (values.json) writeSetupJson(context, { console: client.origin, ...result })
    else context.stdout.write(text)
  }

  if (command === "list") {
    const [apps, me] = await Promise.all([listConsoleApps(client), client.request("/api/whoami")])
    // SAFETY: `/api/whoami` answers the team and the roles of the key.
    const team = { ...me.body.team as { id: string, name: string }, role: (me.body.roles as string[]).join(",") }
    const rows = apps.map(app => [app.id, app.label ?? "", app.url, app.keyVariable ? "app" : "site"])
    write({ apps, team }, apps.length
      ? `${table([["id", "label", "url", "kind"], ...rows])}\n`
      : `Team ${team.name} has no apps. Run \`vitehub apps link <url>\`, or \`vitehub deploy\` in the app folder.\n`)
    return setupExitCodes.done
  }

  if (command === "link") {
    if (values.kind !== undefined && values.kind !== "site") throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] --kind takes only "site". Usage: ${usage.link}` })
    const { app, created } = await linkConsoleApp(client, { url: positionals[0]!, ...(values.label ? { label: values.label } : {}), ...(values.kind === "site" ? { kind: "site" as const } : {}) })
    const verb = created ? "Linked" : "Already linked"
    if (app.keyVariable === null) {
      const script = `<script type="module" src="${client.origin}/hosted-comments.js" data-vitehub-comments="${app.id}"></script>`
      const next = `Add the script to the HTML of ${app.url} and of the pages to review, then open ${app.url}?vitehub and choose Comments.`
      write({ app, script, next }, `${verb} the site ${appName(app)} as ${app.id}.\n${script}\n${next}\n`)
      return setupExitCodes.done
    }
    const variable = `${app.keyVariable}=${app.publicKey}`
    const next = `Set ${app.keyVariable} in the environment of ${app.url}, with console: true in its vitehub config. Deploy it, then run \`vitehub apps check ${app.id}\`.`
    write({ app, variable, next }, `${verb} ${appName(app)} as ${app.id}.\n${variable}\n${next}\n`)
    return setupExitCodes.done
  }

  const id = positionals[0]!
  if (command === "check") {
    const check = await checkConsoleApp(client, id)
    write(check, check.linked ? `The app answers signed requests of ${client.origin}.\n` : `The app does not accept the Console yet: ${checkProblem(check)}\n`)
    return check.linked ? setupExitCodes.done : setupExitCodes.error
  }

  if (!values["delete-hosted-comments"]) {
    throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] Unlinking permanently deletes the hosted comment threads and replies of the app. Pass --delete-hosted-comments to confirm. Usage: ${usage.unlink}` })
  }
  const app = (await listConsoleApps(client)).find(item => item.id === id)
  await client.request(`/api/projects/${encodeURIComponent(id)}?deleteHostedComments=true`, { method: "DELETE" })
  const next = app?.keyVariable ? `Remove ${app.keyVariable} from the environment of ${app.url}.` : ""
  write({ unlinked: id, next }, `Unlinked ${app ? appName(app) : id}.${next ? ` ${next}` : ""}\n`)
  return setupExitCodes.done
}

const appsHelp: Record<AppsCommand, string> = {
  check: "Call project.get on a linked app with a signed request of the Console. Exits with 1 until the app has the variable of the link.",
  link: "Link a deployed ViteHub app to your team, or register a site for Hosted Comments with --kind site. Linking a URL again returns the same link and key. Only owners and admins may link.",
  list: "List the apps of the team of your Console key, with the id that the other commands take.",
  unlink: "Unlink an app. This deletes the private key of the link and the hosted comment threads of the app. Only owners and admins may unlink.",
}

const appsUsage = "vitehub apps <list|link|check|unlink> [args...]"

/** `vitehub apps`: the CLI side of the `list_apps`, `link_app`, `check_app`, and `unlink_app` tools of the Console MCP. */
export const appsCommand: ViteHubCliCommand = {
  description: "List, link, check, and unlink the apps of your team in the ViteHub Console. Each command matches a tool of the Console MCP. Needs `vitehub login`.",
  name: "apps",
  usage: appsUsage,
  run: async (args, context) => {
    const json = args.includes("--json")
    try {
      const [command, ...rest] = args
      if (command === undefined || command === "-h" || command === "--help") {
        context.stdout.write(`Usage: ${appsUsage}\n\n${appsCommand.description}\n\n${(Object.keys(usage) as AppsCommand[]).map(name => `  ${usage[name]}\n    ${appsHelp[name]}`).join("\n")}\n`)
        return setupExitCodes.done
      }
      if (!Object.hasOwn(usage, command)) throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] Unknown command \`vitehub apps ${command}\`. Usage: ${appsUsage}` })
      return await runApps(command as AppsCommand, rest, context)
    }
    catch (error: unknown) {
      return writeSetupError(context, json, error)
    }
  },
}
