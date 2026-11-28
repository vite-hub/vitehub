import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { setupExitCodes, writeSetupError, writeSetupJson } from "./envelope.ts"

import type { ViteHubCliCommand, ViteHubCliContext } from "@vite-hub/internal/cli"

/** The hosted Console. `--console` and `VITEHUB_CONSOLE_URL` name a self-hosted one. */
export const defaultConsoleUrl = "https://console.vitehub.dev"

/** An API key for CI. It wins over the saved key, and `vitehub logout` does not remove it. */
export const consoleTokenVariable = "VITEHUB_CONSOLE_TOKEN"
export const consoleUrlVariable = "VITEHUB_CONSOLE_URL"

const clientId = "vitehub-cli"

/** What `vitehub login` keeps for one Console. The file is readable only by its owner. */
export interface ConsoleCredential {
  token: string
  keyId: string
  user: { id: string, name: string, email?: string }
  team: { id: string, name: string }
  /** Milliseconds since 1970. */
  expiresAt: number
}

interface CredentialsFile {
  version: 1
  consoles: Record<string, ConsoleCredential>
}

/** `$XDG_CONFIG_HOME/vitehub/credentials.json`, else `~/.config/vitehub/credentials.json`. */
export function consoleCredentialsFile(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".config")
  return join(base, "vitehub", "credentials.json")
}

async function readCredentials(file: string, signal?: AbortSignal): Promise<CredentialsFile> {
  const text = await readFile(file, { encoding: "utf8", signal }).catch((error: unknown) => {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return { version: 1, consoles: {} }
  const parsed: unknown = JSON.parse(text)
  const consoles: unknown = parsed instanceof Object ? Reflect.get(parsed, "consoles") : undefined
  // SAFETY: Only `vitehub login` writes this file, with this shape.
  return { version: 1, consoles: consoles instanceof Object ? consoles as Record<string, ConsoleCredential> : {} }
}

async function writeCredentials(file: string, value: CredentialsFile): Promise<void> {
  await mkdir(dirname(file), { mode: 0o700, recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, file)
}

/** The origin of a Console URL. Plain `http` is accepted only for a Console on this machine. */
export function consoleOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] --console must be a URL, such as ${defaultConsoleUrl}. Got ${JSON.stringify(value)}.` })
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] --console must be an https:// URL. Plain http:// is only for a Console on localhost. Got ${url.origin}.` })
  }
  return url.origin
}

/**
 * The key that a command sends to a Console, and where it came from: `VITEHUB_CONSOLE_TOKEN`, else the key that
 * `vitehub login` saved for the Console. Without `console`, the Console is `VITEHUB_CONSOLE_URL`, else the only saved
 * Console, else console.vitehub.dev. `undefined` when there is no key.
 */
export async function readConsoleCredential(env: NodeJS.ProcessEnv, console?: string, signal?: AbortSignal): Promise<{ origin: string, token: string, source: "env" | "file", saved?: ConsoleCredential } | undefined> {
  const file = await readCredentials(consoleCredentialsFile(env), signal)
  const named = console ?? env[consoleUrlVariable]
  const saved = Object.keys(file.consoles)
  const origin = consoleOrigin(named ?? (saved.length === 1 ? saved[0]! : defaultConsoleUrl))
  const token = env[consoleTokenVariable]
  if (token) return { origin, source: "env", token }
  const credential = file.consoles[origin]
  return credential ? { origin, saved: credential, source: "file", token: credential.token } : undefined
}

function readArgs(args: string[], usage: string, extra: { console?: true } = {}) {
  try {
    return parseArgs({
      args,
      options: {
        ...(extra.console ? { console: { type: "string" as const } } : {}),
        help: { short: "h", type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      strict: true,
    }).values as { console?: string, help: boolean, json: boolean }
  }
  catch (error: unknown) {
    throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] ${error instanceof Error ? error.message : String(error)} Usage: ${usage}` })
  }
}

interface DeviceCode {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

interface TokenAnswer {
  access_token: string
  expires_in: number
  key_id: string
  team: { id: string, name: string }
  user: { id: string, name: string, email?: string }
}

async function postJson(context: ViteHubCliContext, url: string, body: object): Promise<{ status: number, headers: Headers, data: Record<string, unknown> }> {
  const response = await (context.fetch ?? fetch)(url, { body: JSON.stringify(body), headers: { accept: "application/json", "content-type": "application/json" }, method: "POST" })
  const data: unknown = await response.json().catch(() => ({}))
  return { data: data instanceof Object ? data as Record<string, unknown> : {}, headers: response.headers, status: response.status }
}

function loginFailed(origin: string, message: string) {
  return cliErrorDiagnostics.CLI_CONSOLE_LOGIN_FAILED({ console: origin, message })
}

const wait = (seconds: number) => new Promise(resolve => setTimeout(resolve, seconds * 1000))

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })

function groupCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
}

async function deviceLogin(origin: string, context: ViteHubCliContext, prompt: ViteHubCliContext["stdout"]): Promise<TokenAnswer> {
  const started = await postJson(context, `${origin}/api/auth/device/code`, { client_id: clientId, client_name: `vitehub CLI on ${hostname()}` }).catch((error: unknown) => {
    throw loginFailed(origin, `The Console did not answer: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (started.status !== 200 || typeof started.data.device_code !== "string") {
    throw loginFailed(origin, `The Console answered ${started.status} to the device code request${typeof started.data.error === "string" ? ` (${started.data.error})` : ""}. Is ${origin} a ViteHub Console?`)
  }
  // SAFETY: The Console's device flow answers RFC 8628 fields; device_code was checked above.
  const code = started.data as unknown as DeviceCode
  prompt.write(`Open ${code.verification_uri} and enter the code ${groupCode(code.user_code)}\n`)
  if (code.verification_uri_complete) prompt.write(`Or open ${code.verification_uri_complete}\n`)
  prompt.write("Waiting for approval...\n")
  let interval = Number.isFinite(code.interval) ? code.interval : 5
  const deadline = Date.now() + code.expires_in * 1000
  while (Date.now() < deadline) {
    await wait(interval)
    const answer = await postJson(context, `${origin}/api/auth/cli/token`, { client_id: clientId, device_code: code.device_code })
    if (answer.status === 200 && typeof answer.data.access_token === "string") {
      // SAFETY: The Console's `/cli/token` answer, with the access token checked above.
      return answer.data as unknown as TokenAnswer
    }
    if (answer.status === 429) {
      interval = Math.max(interval, Number(answer.headers.get("retry-after")) || 60)
      continue
    }
    const error = answer.data.error
    if (error === "authorization_pending") continue
    if (error === "slow_down") {
      interval += 5
      continue
    }
    if (error === "access_denied") throw loginFailed(origin, "The sign-in was denied in the browser.")
    if (error === "expired_token") break
    throw loginFailed(origin, `The Console answered ${answer.status}${typeof error === "string" ? ` (${error})` : ""}.`)
  }
  throw loginFailed(origin, "The code expired before anyone approved it.")
}

const loginUsage = "vitehub login [--console <url>] [--json]"

export const loginCommand: ViteHubCliCommand = {
  description: `Sign in to a ViteHub Console with the device flow, and save an API key for this machine. The default Console is ${defaultConsoleUrl}; --console or ${consoleUrlVariable} names another.`,
  name: "login",
  usage: loginUsage,
  run: async (args, context) => {
    const json = args.includes("--json")
    try {
      const values = readArgs(args, loginUsage, { console: true })
      if (values.help) {
        context.stdout.write(`Usage: ${loginUsage}\n\n${loginCommand.description}\n`)
        return setupExitCodes.done
      }
      const origin = consoleOrigin(values.console ?? context.env[consoleUrlVariable] ?? defaultConsoleUrl)
      const answer = await deviceLogin(origin, context, json ? context.stderr : context.stdout)
      const file = consoleCredentialsFile(context.env)
      const saved = await readCredentials(file)
      const credential: ConsoleCredential = { expiresAt: Date.now() + answer.expires_in * 1000, keyId: answer.key_id, team: answer.team, token: answer.access_token, user: answer.user }
      await writeCredentials(file, { version: 1, consoles: { ...saved.consoles, [origin]: credential } })
      const result = { console: origin, expiresAt: new Date(credential.expiresAt).toISOString(), file, team: credential.team, user: credential.user }
      if (json) writeSetupJson(context, result)
      else context.stdout.write(`Signed in to ${origin} as ${credential.user.name}${credential.user.email ? ` (${credential.user.email})` : ""} in team ${credential.team.name}.\nThe API key expires on ${dateFormat.format(new Date(credential.expiresAt))}. Saved in ${file}.\n`)
      if (context.env[consoleTokenVariable]) context.stderr.write(`[vitehub] ${consoleTokenVariable} is set, so commands use it instead of this key.\n`)
      return setupExitCodes.done
    }
    catch (error: unknown) {
      return writeSetupError(context, json, error)
    }
  },
}

const whoamiUsage = "vitehub whoami [--console <url>] [--json]"

export const whoamiCommand: ViteHubCliCommand = {
  description: `Show the person and the team of the Console API key: ${consoleTokenVariable}, else the key of \`vitehub login\`.`,
  name: "whoami",
  usage: whoamiUsage,
  run: async (args, context) => {
    const json = args.includes("--json")
    try {
      const values = readArgs(args, whoamiUsage, { console: true })
      if (values.help) {
        context.stdout.write(`Usage: ${whoamiUsage}\n\n${whoamiCommand.description}\n`)
        return setupExitCodes.done
      }
      const credential = await readConsoleCredential(context.env, values.console)
      if (!credential) throw cliErrorDiagnostics.CLI_CONSOLE_SIGNED_OUT({ console: consoleOrigin(values.console ?? context.env[consoleUrlVariable] ?? defaultConsoleUrl) })
      const response = await (context.fetch ?? fetch)(`${credential.origin}/api/whoami`, { headers: { accept: "application/json", authorization: `Bearer ${credential.token}` } })
      if (response.status === 401) throw cliErrorDiagnostics.CLI_CONSOLE_SIGNED_OUT({ console: credential.origin })
      if (!response.ok) throw cliErrorDiagnostics.CLI_R0001({ message: `[vitehub] ${credential.origin} answered ${response.status} to /api/whoami.` })
      // SAFETY: The Console's `/api/whoami` answer.
      const me = await response.json() as { user: ConsoleCredential["user"], team: { id: string, name: string }, roles: string[], projectIds: string[] | null, key: { id: string, expiresAt: number } }
      const source = credential.source === "env" ? consoleTokenVariable : consoleCredentialsFile(context.env)
      if (json) {
        writeSetupJson(context, { console: credential.origin, expiresAt: new Date(me.key.expiresAt).toISOString(), projectIds: me.projectIds, roles: me.roles, source, team: me.team, user: me.user })
      }
      else {
        context.stdout.write(`${me.user.name}${me.user.email ? ` (${me.user.email})` : ""} in team ${me.team.name} (${me.roles.join(", ")}) on ${credential.origin}\n`)
        context.stdout.write(`Key from ${source}, for ${me.projectIds ? `${me.projectIds.length} project${me.projectIds.length === 1 ? "" : "s"}` : "every project of the team"}, expires on ${dateFormat.format(new Date(me.key.expiresAt))}.\n`)
      }
      return setupExitCodes.done
    }
    catch (error: unknown) {
      return writeSetupError(context, json, error)
    }
  },
}

const logoutUsage = "vitehub logout [--console <url>] [--json]"

export const logoutCommand: ViteHubCliCommand = {
  description: "Revoke the API key of `vitehub login` on the Console and remove it from this machine.",
  name: "logout",
  usage: logoutUsage,
  run: async (args, context) => {
    const json = args.includes("--json")
    try {
      const values = readArgs(args, logoutUsage, { console: true })
      if (values.help) {
        context.stdout.write(`Usage: ${logoutUsage}\n\n${logoutCommand.description}\n`)
        return setupExitCodes.done
      }
      const file = consoleCredentialsFile(context.env)
      const saved = await readCredentials(file)
      const credential = await readConsoleCredential({ ...context.env, [consoleTokenVariable]: undefined }, values.console)
      if (!credential) {
        if (json) writeSetupJson(context, { removed: false })
        else context.stdout.write("Not signed in.\n")
        return setupExitCodes.done
      }
      const response = await (context.fetch ?? fetch)(`${credential.origin}/api/api-keys/current`, { headers: { authorization: `Bearer ${credential.token}` }, method: "DELETE" }).catch(() => undefined)
      const revoked = response !== undefined && (response.status === 204 || response.status === 401 || response.status === 404)
      const { [credential.origin]: _removed, ...consoles } = saved.consoles
      await writeCredentials(file, { version: 1, consoles })
      if (json) writeSetupJson(context, { console: credential.origin, removed: true, revoked })
      else {
        context.stdout.write(`Signed out of ${credential.origin}.\n`)
        if (!revoked) context.stderr.write("[vitehub] The Console did not revoke the key. Revoke it in Account settings, under API keys.\n")
      }
      if (context.env[consoleTokenVariable]) context.stderr.write(`[vitehub] ${consoleTokenVariable} is still set. Unset it to sign out completely.\n`)
      return setupExitCodes.done
    }
    catch (error: unknown) {
      return writeSetupError(context, json, error)
    }
  },
}
