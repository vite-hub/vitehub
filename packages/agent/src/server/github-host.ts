import { execFile } from "node:child_process"
import type { ExecFileOptionsWithStringEncoding } from "node:child_process"
import { createHash, createSign } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts"

const exec = promisify(execFile)
const GITHUB_RATE_LIMIT_FALLBACK_MS = 5 * 60_000
const GITHUB_RATE_LIMIT_ERROR_CODE = "VITEHUB_GITHUB_RATE_LIMIT"
const GITHUB_GRAPHQL_CHECK_TIMEOUT_MS = 60_000

export type GitHubHostSecret = string | { unseal: () => string }

export interface GitHubHostCredentials {
  appId?: number | string
  installationId?: number | string
  owner?: string
  privateKey?: GitHubHostSecret
  rateLimitKey?: string
  token?: GitHubHostSecret
}

export interface GitHubHostCredentialContext {
  signal: AbortSignal
}

export interface GitHubHostOptions {
  cacheMs?: number
  credentials: (context: GitHubHostCredentialContext) => GitHubHostCredentials | Promise<GitHubHostCredentials>
  graphQLCheckTimeout?: number
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
  headRef?: string
  headRepository?: string
  headSha: string
  number: number
  repository: string
}

export interface GitHubHostCheckoutOptions {
  signal?: AbortSignal
  timeout?: number
}

export interface GitHubGraphQLBudgetOptions extends GitHubHostCheckoutOptions {
  cost: number
}

export interface GitHubHostCommandOptions extends GitHubHostCheckoutOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  repository?: string
}

export interface GitHubHostAccessOptions extends GitHubHostCheckoutOptions {
  fallback?: boolean
  refresh?: boolean
  repository?: string
}

export interface GitHubGraphQLRateLimit {
  checkedAt: number
  remaining: number
  resetAt: number
}

export interface GitHubGraphQLReservation extends GitHubGraphQLRateLimit {
  release(): void
  settle(actualCost: number): void
  submit(): void
}

export interface GitHubHost {
  access(input?: GitHubHostAccessOptions): Promise<GitHubHostAccess>
  budget(): { limited: false } | { limited: true, remaining: number, resetAt: number }
  command(args: string[], input?: GitHubHostCommandOptions): Promise<{ stderr: string, stdout: string }>
  ensureGraphQLBudget(repository: string, options: GitHubGraphQLBudgetOptions): Promise<GitHubGraphQLReservation>
  isRateLimitError(error: unknown): boolean
  withPullRequestCheckout<T>(pullRequest: GitHubHostPullRequest, run: (checkout: GitHubHostAccess & { path: string, push: () => Promise<void>, signal: AbortSignal }) => Promise<T>, options?: GitHubHostCheckoutOptions): Promise<T>
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
  return hasRuntimeType(value, "string") ? value : value?.unseal()
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
  const stderr = isRuntimeRecord(error) && "stderr" in error ? String(error.stderr) : ""
  const message = error instanceof Error ? `${error.message}\n${stderr}` : String(error)
  return /(?:rate limit[^\n]*exceeded|exceeded[^\n]*rate limit)/i.test(message)
}

function secondaryRateLimitMessage(error: unknown): boolean {
  const stderr = isRuntimeRecord(error) && "stderr" in error ? String(error.stderr) : ""
  const message = error instanceof Error ? `${error.message}\n${stderr}` : String(error)
  return /secondary rate limit/i.test(message)
}

function isGraphQLCommand(args: string[]): boolean {
  if (args[0] !== "api") return false
  const optionsWithValues = new Set([
    "--cache", "--field", "--header", "--hostname", "--input", "--jq", "--method", "--preview", "--raw-field", "--template",
    "-F", "-H", "-X", "-f", "-p", "-q", "-t",
  ])
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!
    if (optionsWithValues.has(argument)) {
      index += 1
      continue
    }
    if (argument.startsWith("-")) continue
    return argument === "graphql"
  }
  return false
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException("The operation was aborted.", "AbortError")
}

function controlledOperation(options: GitHubHostCheckoutOptions): { close: () => void, signal: AbortSignal } {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  const timeout = options.timeout === undefined
    ? undefined
    : setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), options.timeout)
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener("abort", abort, { once: true })
  return {
    close: () => {
      if (timeout !== undefined) clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abort)
    },
    signal: controller.signal,
  }
}

async function waitForCaller<T>(promise: Promise<T>, options: GitHubHostCheckoutOptions): Promise<T> {
  if (!options.signal && options.timeout === undefined) return await promise
  if (options.signal?.aborted) throw abortError(options.signal.reason)
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(options.signal?.reason))
    const timeout = options.timeout === undefined
      ? undefined
      : setTimeout(() => reject(new DOMException("The operation timed out.", "TimeoutError")), options.timeout)
    const settle = <TArgs extends unknown[]>(callback: (...args: TArgs) => void) => (...args: TArgs) => {
      if (timeout !== undefined) clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abort)
      callback(...args)
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    promise.then(settle(resolve), settle(reject))
  })
}

export function parseGraphQLRateLimit(value: unknown, checkedAt: number = Date.now()): GitHubGraphQLRateLimit {
  const resources = isRuntimeRecord(value) ? value.resources : undefined
  const graphql = isRuntimeRecord(resources) ? resources.graphql : undefined
  const remaining = isRuntimeRecord(graphql) ? graphql.remaining : undefined
  const reset = isRuntimeRecord(graphql) ? graphql.reset : undefined
  if (!hasRuntimeType(remaining, "number") || !Number.isSafeInteger(remaining) || remaining < 0
    || !hasRuntimeType(reset, "number") || !Number.isSafeInteger(reset) || reset < 1) {
    throw new TypeError("GitHub did not return a valid GraphQL rate limit.")
  }
  return { checkedAt, remaining, resetAt: reset * 1_000 }
}

export function createGitHubHost(options: GitHubHostOptions): GitHubHost {
  const reserve = options.reserve ?? 1_500
  const cacheMs = options.cacheMs ?? 15_000
  const graphQLCheckTimeout = options.graphQLCheckTimeout ?? GITHUB_GRAPHQL_CHECK_TIMEOUT_MS
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024
  const identity = options.identity ?? {}
  const limits = new Map<string, GitHubGraphQLRateLimit>()
  const limitVersions = new Map<string, number>()
  const observedLimits = new Map<string, GitHubGraphQLRateLimit>()
  const reservations = new Map<string, Set<{
    points: number
    resetAt: number
    rolledOver?: boolean
    submittedAtVersion?: number
  }>>()
  const checks = new Map<string, Promise<GitHubGraphQLRateLimit>>()
  const fallbackIdentities = new Map<string, string>()
  const fallbackIdentityLimit = 1_000
  let appToken: { expiresAt: number, token: string } | undefined
  let appTokenKey: string | undefined

  async function credentials(input: GitHubHostCheckoutOptions): Promise<GitHubHostCredentials> {
    const operation = controlledOperation(input)
    try {
      operation.signal.throwIfAborted()
      const pending = Promise.resolve().then(() => options.credentials({ signal: operation.signal }))
      return await waitForCaller(pending, { signal: operation.signal })
    }
    finally {
      operation.close()
    }
  }

  async function fallbackToken(config: GitHubHostCredentials, input: GitHubHostCheckoutOptions): Promise<string> {
    const configured = secret(config.token)?.trim()
    if (configured) return configured
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "GH_TOKEN" && key !== "GITHUB_TOKEN"))
    const result = await exec("gh", ["auth", "token", "--hostname", "github.com"], {
      env: cleanEnv,
      maxBuffer,
      signal: input.signal,
      timeout: input.timeout,
    })
    const token = result.stdout.trim()
    if (!token) throw new Error("GitHub authentication is not configured.")
    return token
  }

  async function fallbackRateLimitKey(token: string, configuredKey: string | undefined, input: GitHubHostCheckoutOptions): Promise<string> {
    const stableKey = configuredKey?.trim()
    if (stableKey) return `credential:${stableKey}`
    const tokenKey = createHash("sha256").update(token).digest("base64url")
    const cached = fallbackIdentities.get(tokenKey)
    if (cached) return cached
    const response = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": options.userAgent || "vitehub",
      },
      signal: input.signal,
    })
    if (response.status === 403) {
      throw new Error("GitHub credentials that cannot identify their user must provide rateLimitKey.")
    }
    if (!response.ok) throw new Error(`GitHub user request failed with ${response.status}.`)
    const body: unknown = await response.json()
    const id = isRuntimeRecord(body) ? body.id : undefined
    if (!hasRuntimeType(id, "number") || !Number.isSafeInteger(id) || id <= 0) {
      throw new TypeError("GitHub did not return a valid authenticated user ID.")
    }
    const key = `user:${id}`
    if (fallbackIdentities.size >= fallbackIdentityLimit) {
      const oldest = fallbackIdentities.keys().next().value
      if (oldest) fallbackIdentities.delete(oldest)
    }
    fallbackIdentities.set(tokenKey, key)
    return key
  }

  async function scopedAccess(input: GitHubHostAccessOptions): Promise<GitHubHostAccess & { rateLimitKey: string }> {
    const config = await credentials({ signal: input.signal })
    const appId = String(config.appId || "").trim()
    const installationId = String(config.installationId || "").trim()
    const appOwner = String(config.owner || "").trim().toLowerCase()
    const privateKey = secret(config.privateKey)?.trim().replace(/\\n/g, "\n") || ""
    const appValues = [appId, installationId, privateKey]
    const repositoryOwner = input.repository ? owner(input.repository) : undefined
    let token: string
    let rateLimitKey: string

    if (appValues.some(Boolean)) {
      if (!appValues.every(Boolean)) throw new Error("GitHub App appId, installationId, and privateKey must be configured together.")
      if (!appOwner) throw new Error("GitHub App owner must be configured with App credentials.")
      if (input.fallback || (repositoryOwner && repositoryOwner !== appOwner)) {
        token = await fallbackToken(config, input)
        rateLimitKey = await fallbackRateLimitKey(token, config.rateLimitKey, input)
      }
      else {
        const numericAppId = positiveInteger(appId, "GitHub App appId")
        const numericInstallationId = positiveInteger(installationId, "GitHub App installationId")
        rateLimitKey = `app:${numericAppId}:${numericInstallationId}`
        const key = `${numericAppId}:${numericInstallationId}:${privateKey}`
        if (input.refresh || !appToken || appTokenKey !== key || appToken.expiresAt <= Date.now() + 60_000) {
          const response = await fetch(`https://api.github.com/app/installations/${numericInstallationId}/access_tokens`, {
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${appJwt(numericAppId, privateKey)}`,
              "user-agent": options.userAgent || "vitehub",
            },
            method: "POST",
            signal: input.signal,
          })
          if (!response.ok) throw new Error(`GitHub App token request failed with ${response.status}.`)
          const body: unknown = await response.json()
          const responseToken = isRuntimeRecord(body) ? body.token : undefined
          const expiresAt = isRuntimeRecord(body) ? body.expires_at : undefined
          if (!hasRuntimeType(responseToken, "string")) throw new Error("GitHub App token response did not include a token.")
          appToken = {
            expiresAt: hasRuntimeType(expiresAt, "string") ? Date.parse(expiresAt) || Date.now() + 50 * 60_000 : Date.now() + 50 * 60_000,
            token: responseToken,
          }
          appTokenKey = key
        }
        token = appToken.token
      }
    }
    else {
      token = await fallbackToken(config, input)
      rateLimitKey = await fallbackRateLimitKey(token, config.rateLimitKey, input)
    }

    const env: Record<string, string> = {
      GH_HOST: "github.com",
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_VALUE_1: "!gh auth git-credential",
      GIT_TERMINAL_PROMPT: "0",
    }
    if (identity.login) {
      env.GIT_AUTHOR_NAME = identity.login
      env.GIT_COMMITTER_NAME = identity.login
    }
    if (identity.email) {
      env.GIT_AUTHOR_EMAIL = identity.email
      env.GIT_COMMITTER_EMAIL = identity.email
    }
    return { env, rateLimitKey, token }
  }

  async function access(input: GitHubHostAccessOptions = {}): Promise<GitHubHostAccess> {
    const operation = controlledOperation(input)
    try {
      return await scopedAccess({ ...input, signal: operation.signal, timeout: undefined })
    }
    finally {
      operation.close()
    }
  }

  async function command(
    args: string[],
    input: GitHubHostCommandOptions = {},
  ): Promise<{ stderr: string, stdout: string }> {
    const operation = controlledOperation(input)
    let auth: Awaited<ReturnType<typeof scopedAccess>> | undefined
    try {
      auth = await scopedAccess({ repository: input.repository, signal: operation.signal })
      const execOptions: ExecFileOptionsWithStringEncoding = {
        encoding: "utf8",
        env: { ...process.env, ...input.env, ...auth.env, GH_HOST: "github.com" },
        maxBuffer,
        signal: operation.signal,
      }
      if (input.cwd) execOptions.cwd = input.cwd
      return await exec("gh", args, execOptions)
    }
    catch (error) {
      if (auth && rateLimitMessage(error)
        && (secondaryRateLimitMessage(error) || isGraphQLCommand(args))) {
        const limit = { checkedAt: Date.now(), remaining: 0, resetAt: Date.now() + GITHUB_RATE_LIMIT_FALLBACK_MS }
        limitVersions.set(auth.rateLimitKey, (limitVersions.get(auth.rateLimitKey) ?? 0) + 1)
        limits.set(auth.rateLimitKey, limit)
        throw new GitHubRateLimitError(input.repository ?? "this credential", limit, error)
      }
      throw error
    }
    finally {
      operation.close()
    }
  }

  async function ensureGraphQLBudget(repository: string, options: GitHubGraphQLBudgetOptions): Promise<GitHubGraphQLReservation> {
    if (!Number.isSafeInteger(options.cost) || options.cost <= 0) throw new TypeError("GitHub GraphQL cost must be a positive integer.")
    const operation = controlledOperation(options)
    try {
      operation.signal.throwIfAborted()
      const auth = await scopedAccess({ repository, signal: operation.signal })
      const key = auth.rateLimitKey
      const now = Date.now()
      const cached = limits.get(key)
      const admit = (limit: GitHubGraphQLRateLimit): GitHubGraphQLReservation => {
        const current = limits.get(key)
        const available = current?.checkedAt === limit.checkedAt && current.remaining <= limit.remaining ? current : limit
        if (available.resetAt > Date.now() && available.remaining - options.cost < reserve) {
          throw new GitHubRateLimitError(repository, available)
        }
        const reserved = { ...available, remaining: available.remaining - options.cost }
        const limitVersion = limitVersions.get(key) ?? 0
        const reservation: {
          points: number
          resetAt: number
          rolledOver?: boolean
          submittedAtVersion?: number
        } = { points: options.cost, resetAt: available.resetAt }
        const outstanding = reservations.get(key) ?? new Set()
        outstanding.add(reservation)
        reservations.set(key, outstanding)
        limits.set(key, reserved)
        let settled = false
        const settle = (actualCost: number, released: boolean = false) => {
          if (!Number.isSafeInteger(actualCost) || actualCost < 0) {
            throw new TypeError("GitHub GraphQL actual cost must be a non-negative integer.")
          }
          if (actualCost > options.cost) {
            throw new RangeError("GitHub GraphQL actual cost cannot exceed its reserved cost.")
          }
          if (settled) return
          if (!released && reservation.submittedAtVersion === undefined) {
            throw new Error("GitHub GraphQL reservations must be submitted before they are settled.")
          }
          if (released && reservation.submittedAtVersion !== undefined) {
            throw new Error("Submitted GitHub GraphQL reservations cannot be released.")
          }
          settled = true
          const outstanding = reservations.get(key)
          if (!outstanding?.delete(reservation)) return
          if (outstanding.size === 0) reservations.delete(key)
          const releasedPoints = options.cost - actualCost
          const current = limits.get(key)
          if (current?.resetAt === reservation.resetAt) {
            const observed = observedLimits.get(key)
            const remaining = current.remaining + releasedPoints
            limits.set(key, {
              ...current,
              remaining: observed?.resetAt === current.resetAt ? Math.min(remaining, observed.remaining) : remaining,
            })
          }
        }
        return {
          ...reserved,
          release() {
            settle(0, true)
          },
          settle,
          submit() {
            if (settled) throw new Error("Settled GitHub GraphQL reservations cannot be submitted.")
            reservation.submittedAtVersion ??= limitVersions.get(key) ?? limitVersion
          },
        }
      }
      if (cached && cached.resetAt > now && now - cached.checkedAt < cacheMs) return admit(cached)
      const pending = checks.get(key)
      if (pending) return admit(await waitForCaller(pending, { signal: operation.signal }))
      const check = (async () => {
        const checkOperation = controlledOperation({ timeout: graphQLCheckTimeout })
        try {
          const result = await exec("gh", ["api", "--hostname", "github.com", "rate_limit"], {
            encoding: "utf8",
            env: { ...process.env, ...auth.env },
            maxBuffer,
            signal: checkOperation.signal,
          })
          const limit = parseGraphQLRateLimit(JSON.parse(result.stdout), now)
          observedLimits.set(key, limit)
          const activeReservations = reservations.get(key)
          if (activeReservations) {
            for (const reservation of activeReservations) {
              if (reservation.resetAt === limit.resetAt) continue
              if (reservation.submittedAtVersion === undefined || reservation.rolledOver) {
                activeReservations.delete(reservation)
              }
              else {
                reservation.resetAt = limit.resetAt
                reservation.rolledOver = true
                reservation.submittedAtVersion = (limitVersions.get(key) ?? 0) + 1
              }
            }
            if (activeReservations.size === 0) reservations.delete(key)
          }
          const outstanding = [...(activeReservations ?? [])]
            .filter(reservation => reservation.resetAt === limit.resetAt
              && (reservation.submittedAtVersion === undefined || reservation.rolledOver))
            .reduce((points, reservation) => points + reservation.points, 0)
          const current = limits.get(key)
          const reconciled = current !== undefined
            && current.resetAt > Date.now()
            && current.resetAt === limit.resetAt
            ? { ...limit, remaining: Math.min(current.remaining, limit.remaining - outstanding) }
            : { ...limit, remaining: limit.remaining - outstanding }
          limitVersions.set(key, (limitVersions.get(key) ?? 0) + 1)
          limits.set(key, reconciled)
          return reconciled
        }
        catch (error) {
          if (rateLimitMessage(error)) {
            const limit = { checkedAt: Date.now(), remaining: 0, resetAt: Date.now() + GITHUB_RATE_LIMIT_FALLBACK_MS }
            limitVersions.set(key, (limitVersions.get(key) ?? 0) + 1)
            limits.set(key, limit)
            throw new GitHubRateLimitError(repository, limit, error)
          }
          throw error
        }
        finally {
          checkOperation.close()
        }
      })().finally(() => checks.delete(key))
      checks.set(key, check)
      return admit(await waitForCaller(check, { signal: operation.signal }))
    }
    finally {
      operation.close()
    }
  }

  function budget(): { limited: false } | { limited: true, remaining: number, resetAt: number } {
    const limited = [...limits.values()].filter(limit => limit.remaining <= reserve && limit.resetAt > Date.now())
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
    run: (checkout: GitHubHostAccess & { path: string, push: () => Promise<void>, signal: AbortSignal }) => Promise<T>,
    options: GitHubHostCheckoutOptions = {},
  ): Promise<T> {
    const checkout = await mkdtemp(join(tmpdir(), `vitehub-${pullRequest.repository.replace("/", "-")}-pr-${pullRequest.number}-`))
    const operation = controlledOperation(options)
    try {
      const baseAuth = await access({
        refresh: true,
        repository: pullRequest.repository,
        signal: operation.signal,
      })
      const env = { ...process.env, ...baseAuth.env, GH_HOST: "github.com" }
      const commandOptions = { env, maxBuffer, signal: operation.signal }
      await exec("gh", ["repo", "clone", `https://github.com/${pullRequest.repository}.git`, checkout, "--", "--filter=blob:none", "--no-checkout"], commandOptions)
      await exec("gh", ["pr", "checkout", String(pullRequest.number), "--repo", pullRequest.repository], { ...commandOptions, cwd: checkout })
      await exec("git", ["-C", checkout, "remote", "set-url", "origin", `https://github.com/${pullRequest.repository}.git`], commandOptions)
      const pushUrl = pullRequest.headRepository
        ? `https://github.com/${pullRequest.headRepository}.git`
        : "disabled://pull-request-head-repository-unavailable"
      await exec("git", ["-C", checkout, "remote", "set-url", "--push", "origin", pushUrl], commandOptions)
      if (pullRequest.headRepository) {
        if (!pullRequest.headRef) throw new Error("A pull request headRef is required when headRepository is supplied.")
        await exec("git", ["-C", checkout, "config", "remote.origin.push", `HEAD:refs/heads/${pullRequest.headRef}`], commandOptions)
      }
      const fetched = (await exec("git", ["-C", checkout, "rev-parse", "HEAD"], commandOptions)).stdout.trim()
      if (fetched !== pullRequest.headSha) throw new Error(`Pull request head changed from ${pullRequest.headSha} to ${fetched}.`)
      operation.signal.throwIfAborted()
      const push = async () => {
        const refreshed = await access({
          refresh: true,
          repository: pullRequest.headRepository || pullRequest.repository,
          signal: operation.signal,
        })
        await exec("git", ["-C", checkout, "push", "origin"], {
          env: { ...process.env, ...refreshed.env },
          maxBuffer,
          signal: operation.signal,
        })
      }
      return await run({ ...baseAuth, path: checkout, push, signal: operation.signal })
    }
    finally {
      operation.close()
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
