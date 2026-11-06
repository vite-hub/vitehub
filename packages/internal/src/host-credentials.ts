import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type CredentialHost = "cloudflare" | "vercel" | "netlify" | "deno"
export type CredentialSource = "env" | "host-cli"

export type HostCredentials =
  | { ok: true, host: CredentialHost, source: CredentialSource, token: string, accountId?: string, teamId?: string }
  | { ok: false, host: CredentialHost, missing: readonly string[], fix: string }

/** Credential status without the token, safe for `status` and JSON output. */
export type HostCredentialsDescription =
  | { ok: true, host: CredentialHost, source: CredentialSource, accountId?: string, teamId?: string }
  | { ok: false, host: CredentialHost, missing: readonly string[], fix: string }

export interface HostCliRunResult {
  exitCode: number | null
  stdout: string
}

/** Runs a host CLI with an argument array and no shell, and returns its stdout. */
export type HostCliRun = (command: string, args: readonly string[], options: { cwd?: string, env: NodeJS.ProcessEnv }) => Promise<HostCliRunResult>

export interface HostCredentialsContext {
  /** Directory whose activated Wrangler profile is used. Defaults to the process cwd. */
  cwd?: string
  /** Only this object is read. A project `.env` file is never read. */
  env: NodeJS.ProcessEnv
  /** Replaces the host CLI runner, so tests need no real CLI. */
  run?: HostCliRun
}

type EnvCredentials = Omit<Extract<HostCredentials, { ok: true }>, "ok" | "host" | "source">

const missingFixes: Record<CredentialHost, { missing: readonly string[], fix: string }> = {
  cloudflare: { missing: ["CLOUDFLARE_API_TOKEN"], fix: "Run `wrangler login`, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID." },
  // Vercel and Netlify have no documented command that prints the login token, so only env vars work.
  vercel: { missing: ["VERCEL_TOKEN"], fix: "Set VERCEL_TOKEN to a token from https://vercel.com/account/tokens. Set VERCEL_TEAM_ID for a team." },
  netlify: { missing: ["NETLIFY_AUTH_TOKEN"], fix: "Set NETLIFY_AUTH_TOKEN to a token from https://app.netlify.com/user/applications#personal-access-tokens." },
  deno: { missing: ["DENO_DEPLOY_TOKEN"], fix: "Set DENO_DEPLOY_TOKEN to a token from your Deno Deploy account settings." },
}

const HOST_CLI_TIMEOUT_MS = 30_000

/** Reads host credentials from environment variables only. Returns undefined when the token is not set. */
export function readHostCredentialsFromEnv(host: CredentialHost, env: Record<string, string | undefined>): EnvCredentials | undefined {
  switch (host) {
    case "cloudflare": {
      const token = trimmed(env.CLOUDFLARE_API_TOKEN)
      const accountId = trimmed(env.CLOUDFLARE_ACCOUNT_ID)
      return token ? { token, ...(accountId && { accountId }) } : undefined
    }
    case "vercel": {
      const token = trimmed(env.VERCEL_TOKEN)
      const teamId = trimmed(env.VERCEL_TEAM_ID) ?? trimmed(env.VERCEL_ORG_ID)
      return token ? { token, ...(teamId && { teamId }) } : undefined
    }
    case "netlify": {
      const token = trimmed(env.NETLIFY_AUTH_TOKEN)
      return token ? { token } : undefined
    }
    case "deno": {
      const token = trimmed(env.DENO_DEPLOY_TOKEN)
      return token ? { token } : undefined
    }
  }
}

/**
 * Finds credentials for a host: environment variables first, then the host CLI login.
 * It never writes credentials and never reads another tool's auth files.
 */
export async function resolveHostCredentials(host: CredentialHost, context: HostCredentialsContext): Promise<HostCredentials> {
  const fromEnv = readHostCredentialsFromEnv(host, context.env)
  if (fromEnv) {
    if (host === "cloudflare" && !fromEnv.accountId) {
      const accountId = await readWranglerAccountId(context)
      return { ok: true, host, source: "env", ...fromEnv, ...(accountId && { accountId }) }
    }
    return { ok: true, host, source: "env", ...fromEnv }
  }
  if (host === "cloudflare") {
    const token = await readWranglerToken(context)
    if (token) {
      const accountId = trimmed(context.env.CLOUDFLARE_ACCOUNT_ID) ?? await readWranglerAccountId(context)
      return { ok: true, host, source: "host-cli", token, ...(accountId && { accountId }) }
    }
  }
  return { ok: false, host, ...missingFixes[host] }
}

/** Same as resolveHostCredentials but never returns the token: for status and JSON output. */
export async function describeHostCredentials(host: CredentialHost, context: HostCredentialsContext): Promise<HostCredentialsDescription> {
  const credentials = await resolveHostCredentials(host, context)
  if (!credentials.ok) return credentials
  const { token: _token, ...description } = credentials
  return description
}

// `wrangler auth token --json` prints `{ type: "oauth" | "api_token", token }` or `{ type: "api_key", key, email }`.
// An API key needs an email header, so only a bearer token counts as a login here.
async function readWranglerToken(context: HostCredentialsContext): Promise<string | undefined> {
  const value = await runJson(context, "wrangler", ["auth", "token", "--json"])
  if (!isRecord(value) || (value.type !== "oauth" && value.type !== "api_token")) return
  return typeof value.token === "string" ? trimmed(value.token) : undefined
}

// `wrangler whoami --json` lists the accounts of the login. Only one account is an unambiguous choice.
async function readWranglerAccountId(context: HostCredentialsContext): Promise<string | undefined> {
  const value = await runJson(context, "wrangler", ["whoami", "--json"])
  if (!isRecord(value) || value.loggedIn !== true || !Array.isArray(value.accounts) || value.accounts.length !== 1) return
  const [account] = value.accounts
  return isRecord(account) && typeof account.id === "string" ? trimmed(account.id) : undefined
}

// A CLI that is not installed, exits non-zero, or prints something else means "not logged in".
async function runJson(context: HostCredentialsContext, command: string, args: readonly string[]): Promise<unknown> {
  const run = context.run ?? runHostCli
  let cwd: string | undefined
  try {
    // Wrangler loads project .env files before dispatch and searches ancestors for config.
    // Keep the empty config under the caller's directory so its activated profile is inherited.
    // Explicit empty files still prevent project env and config discovery.
    cwd = await mkdtemp(join(context.cwd ?? process.cwd(), ".vitehub-wrangler-auth-"))
    await writeFile(join(cwd, ".env"), "")
    await writeFile(join(cwd, "wrangler.json"), "{}")
    const result = await run(command, [...args, "--env-file", ".env", "--config", "wrangler.json"], { cwd, env: context.env })
    if (result.exitCode !== 0) return
    return JSON.parse(result.stdout)
  }
  catch {
    return
  }
  finally {
    if (cwd) await rm(cwd, { force: true, recursive: true })
  }
}

/** The default host CLI runner. stdin is closed so a CLI cannot wait for a prompt. */
export const runHostCli: HostCliRun = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    // Windows needs a shell to run `.cmd` shims. The arguments are fixed literals.
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: HOST_CLI_TIMEOUT_MS,
  })
  const chunks: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
  child.on("error", reject)
  child.on("close", exitCode => resolve({ exitCode, stdout: Buffer.concat(chunks).toString("utf8") }))
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim()
  return result ? result : undefined
}
