import { execFile } from "node:child_process"
import { createSign } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const GITHUB_RATE_LIMIT_FALLBACK_MS = 5 * 60_000
const GITHUB_RATE_LIMIT_ERROR_CODE = "VITEHUB_GITHUB_RATE_LIMIT"

export type GitHubHostSecret = string | { unseal: () => string }

export interface GitHubHostCredentials {
  appId?: number | string
  installationId?: number | string
  owner?: string
  privateKey?: GitHubHostSecret
  token?: GitHubHostSecret
}

export interface GitHubHostOptions {
  cacheMs?: number
  credentials: () => GitHubHostCredentials | Promise<GitHubHostCredentials>
  identity?: { email?: string, login?: string }
  maxBuffer?: number
  reserve?: number
  userAgent?: string
}

export interface GitHubHostAccess {
  env: Record<string, string>
  token: string
}

export interface GitHubHostPullRequest {
  headRepository?: string
  headSha: string
  number: number
  repository: string
}

export interface GitHubGraphQLRateLimit {
  checkedAt: number
  remaining: number
  resetAt: number
}

export interface GitHubHost {
  access(input?: { fallback?: boolean, refresh?: boolean, repository?: string }): Promise<GitHubHostAccess>
  budget(): { limited: false } | { limited: true, remaining: number, resetAt: number }
  command(args: string[], input?: { cwd?: string, env?: NodeJS.ProcessEnv, repository?: string }): Promise<{ stderr: string, stdout: string }>
  ensureGraphQLBudget(repository: string): Promise<GitHubGraphQLRateLimit>
  isRateLimitError(error: unknown): boolean
  withPullRequestCheckout<T>(pullRequest: GitHubHostPullRequest, run: (checkout: GitHubHostAccess & { path: string }) => Promise<T>): Promise<T>
}

class GitHubRateLimitError extends Error {
  readonly code = GITHUB_RATE_LIMIT_ERROR_CODE
  readonly resetAt: number

  constructor(repository: string, limit: GitHubGraphQLRateLimit, cause?: unknown) {
    super(
      `GitHub GraphQL work for ${repository} is queued until ${new Date(limit.resetAt).toISOString()} (${limit.remaining} points remaining).`,
      cause === undefined ? undefined : { cause },
    )
    this.name = "GitHubRateLimitError"
    this.resetAt = limit.resetAt
  }
}

function secret(value: GitHubHostSecret | undefined): string | undefined {
  return typeof value === "string" ? value : value?.unseal()
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer.`)
  return number
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url")
}

function appJwt(appId: number, privateKey: string): string {
  const now = Math.floor(Date.now() / 1_000)
  const data = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ exp: now + 540, iat: now - 60, iss: appId }))}`
  return `${data}.${createSign("RSA-SHA256").update(data).sign(privateKey).toString("base64url")}`
}

function owner(repository: string): string {
  return repository.split("/", 1)[0]!.toLowerCase()
}

function rateLimitMessage(error: unknown): boolean {
  const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : ""
  const message = error instanceof Error ? `${error.message}\n${stderr}` : String(error)
  return /rate limit (?:already )?exceeded/i.test(message)
}

export function parseGraphQLRateLimit(value: unknown, checkedAt: number = Date.now()): GitHubGraphQLRateLimit {
  const resources = typeof value === "object" && value !== null && "resources" in value ? value.resources : undefined
  const graphql = typeof resources === "object" && resources !== null && "graphql" in resources ? resources.graphql : undefined
  const remaining = typeof graphql === "object" && graphql !== null && "remaining" in graphql ? graphql.remaining : undefined
  const reset = typeof graphql === "object" && graphql !== null && "reset" in graphql ? graphql.reset : undefined
  if (!Number.isSafeInteger(remaining) || typeof remaining !== "number" || remaining < 0
    || !Number.isSafeInteger(reset) || typeof reset !== "number" || reset < 1) {
    throw new TypeError("GitHub did not return a valid GraphQL rate limit.")
  }
  return { checkedAt, remaining, resetAt: reset * 1_000 }
}

export function createGitHubHost(options: GitHubHostOptions): GitHubHost {
  const reserve = options.reserve ?? 1_500
  const cacheMs = options.cacheMs ?? 15_000
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024
  const identity = options.identity ?? {}
  const limits = new Map<string, GitHubGraphQLRateLimit>()
  const checks = new Map<string, Promise<GitHubGraphQLRateLimit>>()
  let appToken: { expiresAt: number, token: string } | undefined
  let appTokenKey: string | undefined

  async function fallbackToken(config: GitHubHostCredentials): Promise<string> {
    const configured = secret(config.token)?.trim()
    if (configured) return configured
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "GH_TOKEN" && key !== "GITHUB_TOKEN"))
    const result = await exec("gh", ["auth", "token", "--hostname", "github.com"], { env: cleanEnv, maxBuffer })
    const token = result.stdout.trim()
    if (!token) throw new Error("GitHub authentication is not configured.")
    return token
  }

  async function access(input: { fallback?: boolean, refresh?: boolean, repository?: string } = {}): Promise<GitHubHostAccess> {
    const config = await options.credentials()
    const appId = String(config.appId || "").trim()
    const installationId = String(config.installationId || "").trim()
    const appOwner = String(config.owner || "").trim().toLowerCase()
    const privateKey = secret(config.privateKey)?.trim().replace(/\\n/g, "\n") || ""
    const appValues = [appId, installationId, privateKey]
    const repositoryOwner = input.repository ? owner(input.repository) : undefined
    let token: string

    if (appValues.some(Boolean)) {
      if (!appValues.every(Boolean)) throw new Error("GitHub App appId, installationId, and privateKey must be configured together.")
      if (!appOwner) throw new Error("GitHub App owner must be configured with App credentials.")
      if (input.fallback || (repositoryOwner && repositoryOwner !== appOwner)) {
        token = await fallbackToken(config)
      }
      else {
        const numericAppId = positiveInteger(appId, "GitHub App appId")
        const numericInstallationId = positiveInteger(installationId, "GitHub App installationId")
        const key = `${numericAppId}:${numericInstallationId}:${privateKey}`
        if (input.refresh || !appToken || appTokenKey !== key || appToken.expiresAt <= Date.now() + 60_000) {
          const response = await fetch(`https://api.github.com/app/installations/${numericInstallationId}/access_tokens`, {
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${appJwt(numericAppId, privateKey)}`,
              "user-agent": options.userAgent || "vitehub",
            },
            method: "POST",
          })
          if (!response.ok) throw new Error(`GitHub App token request failed with ${response.status}.`)
          const body: unknown = await response.json()
          const responseToken = typeof body === "object" && body !== null && "token" in body ? body.token : undefined
          const expiresAt = typeof body === "object" && body !== null && "expires_at" in body ? body.expires_at : undefined
          if (typeof responseToken !== "string") throw new Error("GitHub App token response did not include a token.")
          appToken = {
            expiresAt: typeof expiresAt === "string" ? Date.parse(expiresAt) || Date.now() + 50 * 60_000 : Date.now() + 50 * 60_000,
            token: responseToken,
          }
          appTokenKey = key
        }
        token = appToken.token
      }
    }
    else {
      token = await fallbackToken(config)
    }

    return {
      env: {
        GH_TOKEN: token,
        GITHUB_TOKEN: token,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        ...(identity.login ? { GIT_AUTHOR_NAME: identity.login, GIT_COMMITTER_NAME: identity.login } : {}),
        ...(identity.email ? { GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_EMAIL: identity.email } : {}),
      },
      token,
    }
  }

  async function command(
    args: string[],
    input: { cwd?: string, env?: NodeJS.ProcessEnv, repository?: string } = {},
  ): Promise<{ stderr: string, stdout: string }> {
    const auth = await access({ repository: input.repository })
    try {
      return await exec("gh", args, {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        env: { ...process.env, ...input.env, ...auth.env },
        maxBuffer,
      })
    }
    catch (error) {
      if (input.repository && rateLimitMessage(error)) {
        const limit = { checkedAt: Date.now(), remaining: 0, resetAt: Date.now() + GITHUB_RATE_LIMIT_FALLBACK_MS }
        limits.set(owner(input.repository), limit)
        throw new GitHubRateLimitError(input.repository, limit, error)
      }
      throw error
    }
  }

  async function ensureGraphQLBudget(repository: string): Promise<GitHubGraphQLRateLimit> {
    const key = owner(repository)
    const now = Date.now()
    const cached = limits.get(key)
    if (cached && cached.resetAt > now && cached.remaining < reserve) throw new GitHubRateLimitError(repository, cached)
    if (cached && now - cached.checkedAt < cacheMs) return cached
    const pending = checks.get(key)
    if (pending) return await pending
    const check = (async () => {
      const result = await command(["api", "rate_limit"], { repository })
      const limit = parseGraphQLRateLimit(JSON.parse(result.stdout), now)
      limits.set(key, limit)
      if (limit.remaining < reserve && limit.resetAt > now) throw new GitHubRateLimitError(repository, limit)
      return limit
    })().finally(() => checks.delete(key))
    checks.set(key, check)
    return await check
  }

  function budget(): { limited: false } | { limited: true, remaining: number, resetAt: number } {
    const limited = [...limits.values()].filter(limit => limit.remaining < reserve && limit.resetAt > Date.now())
    return limited.length
      ? {
          limited: true,
          remaining: Math.min(...limited.map(limit => limit.remaining)),
          resetAt: Math.max(...limited.map(limit => limit.resetAt)),
        }
      : { limited: false }
  }

  async function withPullRequestCheckout<T>(
    pullRequest: GitHubHostPullRequest,
    run: (checkout: GitHubHostAccess & { path: string }) => Promise<T>,
  ): Promise<T> {
    const checkout = await mkdtemp(join(tmpdir(), `vitehub-${pullRequest.repository.replace("/", "-")}-pr-${pullRequest.number}-`))
    try {
      const auth = await access({
        refresh: true,
        repository: pullRequest.headRepository || pullRequest.repository,
      })
      const env = { ...process.env, ...auth.env }
      await exec("gh", ["repo", "clone", pullRequest.repository, checkout, "--", "--filter=blob:none", "--no-checkout"], { env, maxBuffer })
      await exec("gh", ["pr", "checkout", String(pullRequest.number), "--repo", pullRequest.repository, "--detach"], { cwd: checkout, env, maxBuffer })
      await exec("git", ["-C", checkout, "remote", "set-url", "origin", `https://github.com/${pullRequest.repository}.git`], { maxBuffer })
      const pushUrl = pullRequest.headRepository
        ? `https://github.com/${pullRequest.headRepository}.git`
        : "disabled://pull-request-head-repository-unavailable"
      await exec("git", ["-C", checkout, "remote", "set-url", "--push", "origin", pushUrl], { maxBuffer })
      const fetched = (await exec("git", ["-C", checkout, "rev-parse", "HEAD"], { maxBuffer })).stdout.trim()
      if (fetched !== pullRequest.headSha) throw new Error(`Pull request head changed from ${pullRequest.headSha} to ${fetched}.`)
      return await run({ ...auth, path: checkout })
    }
    finally {
      await rm(checkout, { force: true, recursive: true })
    }
  }

  return {
    access,
    budget,
    command,
    ensureGraphQLBudget,
    isRateLimitError: (error: unknown) => error instanceof GitHubRateLimitError,
    withPullRequestCheckout,
  }
}
