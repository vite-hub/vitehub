import { github, type GitHubChannelOptions } from '../channels.ts'
import type { AgentChannelDefinition } from '../types.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from "node:child_process"
import type { ExecFileOptionsWithStringEncoding } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdtemp, readdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { Diagnostic } from "nostics"

import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts"
import { CodeHostResponseError, codeHostErrorStatus, codeHostProvider, githubAppCredentials } from "../internal/code-host.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { prepareGitHubPullRequestWorkspace } from "./github-checkout.ts"
import { commitGitHubPullRequestWorkspace, type GitHubRepairCommit } from "./github-repair.ts"

const exec = promisify(execFile)
const GITHUB_RATE_LIMIT_FALLBACK_MS = 5 * 60_000
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
  /** Repository whose GitHub credentials are needed; omitted for unscoped access. */
  repository?: string
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

export interface GitHubHostCheckout extends GitHubHostAccess {
  path: string
  /** Restore source instruction files only before the provider injects its instructions. */
  prepareWorkspace(target: string, options?: { restoreInstructions?: boolean }): Promise<void>
  commitRepair(target: string, input: GitHubRepairCommit, options?: { verifyDependencies?: boolean }): Promise<string>
  push(target?: string, options?: { signal?: AbortSignal, beforePush?: (head?: string) => void | Promise<void>, afterPush?: (head: string) => void | Promise<void> }): Promise<string>
  signal: AbortSignal
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
  env?: Record<string, string | undefined>
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
  channel(options?: Omit<GitHubChannelOptions, 'app'>): AgentChannelDefinition
  /** Return the verified login configured for this host, when available. */
  identity(): string | undefined
  /** Resolve credentials and Git binding for the current checkout callback. */
  environment(): Promise<Record<string, string>>
  access(input?: GitHubHostAccessOptions): Promise<GitHubHostAccess>
  budget(): { limited: false } | { limited: true, remaining: number, resetAt: number }
  command(args: string[], input?: GitHubHostCommandOptions): Promise<{ stderr: string, stdout: string }>
  ensureGraphQLBudget(repository: string, options: GitHubGraphQLBudgetOptions): Promise<GitHubGraphQLReservation>
  isRateLimitError(error: unknown): boolean
  withPullRequestCheckout<T>(pullRequest: GitHubHostPullRequest, run: (checkout: GitHubHostCheckout) => Promise<T>, options?: GitHubHostCheckoutOptions): Promise<T>
}

class GitHubRateLimitError extends Diagnostic {
  readonly resetAt: number

  constructor(repository: string, limit: GitHubGraphQLRateLimit, cause?: unknown) {
    super({
      cause,
      code: "AGENT_R0889",
      docs: "https://vitehub.dev/docs/reference/errors-diagnostics#agent-public-errors",
      why: `GitHub GraphQL work for ${repository} is queued until ${new Date(limit.resetAt).toISOString()} (${limit.remaining} points remaining).`,
    }, GitHubRateLimitError)
    this.name = "GitHubRateLimitError"
    this.resetAt = limit.resetAt
  }
}

function secret(value: GitHubHostSecret | undefined): string | undefined {
  return hasRuntimeType(value, "string") ? value : value?.unseal()
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw agentDiagnostics.AGENT_R0748({ message: `${name} must be a positive integer.` })
  return number
}

export interface GitHubAppEnvironment {
  appId: number
  privateKey: string
  /** Fixed installation. Without it, each repository resolves its own installation. */
  installationId?: number
  /** Owner authorized by the fixed installation; other owners are discovered. */
  owner?: string
  /** Explicit installation IDs by repository owner. */
  installations?: Record<string, number>
  /** Fallback token for repositories without an App installation. */
  token?: string
  userAgent?: string
}

/**
 * GitHub App credentials for `createGitHubHost()` that resolve the installation of each
 * repository from the App, and the App's bot identity for commits. Results are cached.
 */
export function createGitHubAppCredentials(app: GitHubAppEnvironment) {
  const configuredInstallations = new Map(Object.entries(app.installations ?? {}).map(([name, id]) => [name.toLowerCase(), id]));
  const installations = new Map<string, number>()
  let identity: Promise<{ login: string, email: string }> | undefined
  const client = githubAppCredentials(app)
  const installation = async (repository: string, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const key = owner(repository)
    const cached = installations.get(key)
    if (cached !== undefined) return cached
    // Unresolved lookups belong to each caller's signal. Cache only completed discovery.
    const resolved = await client.installation(repository, signal)
    signal?.throwIfAborted()
    installations.set(key, resolved)
    return resolved
  }
  return {
    async credentials(context: GitHubHostCredentialContext): Promise<GitHubHostCredentials> {
      if (!context.repository) return { token: app.token }
      const repositoryOwner = owner(context.repository)
      const configured = configuredInstallations.get(repositoryOwner) ?? (!app.owner || app.owner.toLowerCase() === repositoryOwner ? app.installationId : undefined)
      const installationId = configured ?? await installation(context.repository, context.signal)
      return { appId: app.appId, installationId, owner: owner(context.repository), privateKey: app.privateKey, token: app.token }
    },
    /** The App bot's login and noreply email, used as the commit author. */
    async identity(): Promise<{ login: string, email: string }> {
      identity ??= (async () => {
        const { login } = await client.app().catch((error: unknown) => {
          const status = codeHostErrorStatus(error)
          if (status !== undefined) throw agentDiagnostics.AGENT_R0757({ message: `GitHub App request /app failed with ${status}.`, cause: error })
          if (error instanceof CodeHostResponseError) throw agentDiagnostics.AGENT_R0757({ message: error.message, cause: error })
          throw error
        })
        const provider = await codeHostProvider({ host: "github", userAgent: app.userAgent })
        const user = await provider.users.get(login).catch(() => undefined)
        return { login, email: user?.id ? `${user.id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com` }
      })()
      identity.catch(() => { identity = undefined })
      return await identity
    },
  }
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
    throw agentDiagnostics.AGENT_R0749({ message: "GitHub did not return a valid GraphQL rate limit." })
  }
  return { checkedAt, remaining, resetAt: reset * 1_000 }
}

export function createGitHubHost(options: GitHubHostOptions): GitHubHost {
  const checkoutScope = new AsyncLocalStorage<GitHubHostAccess & { path: string }>()
  const reserve = options.reserve ?? 1_500
  const cacheMs = options.cacheMs ?? 15_000
  const graphQLCheckTimeout = options.graphQLCheckTimeout ?? GITHUB_GRAPHQL_CHECK_TIMEOUT_MS
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024
  const identity = options.identity ?? {}
  const limits = new Map<string, GitHubGraphQLRateLimit>()
  const limitVersions = new Map<string, number>()
  const observedLimits = new Map<string, GitHubGraphQLRateLimit & { version: number }>()
  const reservations = new Map<string, Set<{
    admittedAtVersion: number
    expired?: boolean
    points: number
    resetAt: number
    rolledOver?: boolean
    submittedAtVersion?: number
  }>>()
  const checks = new Map<string, Promise<GitHubGraphQLRateLimit>>()
  const commands = new Map<string, number>()
  const fallbackIdentities = new Map<string, string>()
  const fallbackIdentityLimit = 1_000
  const budgetStateLimit = 1_000
  const budgetStateAccess = new Map<string, number>()

  function touchBudgetState(key: string, now: number): void {
    if (budgetStateAccess.has(key)) {
      budgetStateAccess.delete(key)
      budgetStateAccess.set(key, now)
      return
    }
    while (budgetStateAccess.size >= budgetStateLimit) {
      let evicted = false
      for (const [candidate] of budgetStateAccess) {
        if (reservations.has(candidate) || checks.has(candidate) || commands.has(candidate)) continue
        const limit = limits.get(candidate)
        if (limit?.remaining === 0 && limit.resetAt > now) continue
        budgetStateAccess.delete(candidate)
        limits.delete(candidate)
        limitVersions.delete(candidate)
        observedLimits.delete(candidate)
        evicted = true
        break
      }
      if (!evicted) throw agentDiagnostics.AGENT_R0750({ message: "GitHub credential budget state capacity is exhausted by active rate limits." })
    }
    budgetStateAccess.delete(key)
    budgetStateAccess.set(key, now)
  }

  async function credentials(input: GitHubHostAccessOptions): Promise<GitHubHostCredentials> {
    const operation = controlledOperation(input)
    try {
      operation.signal.throwIfAborted()
      const pending = Promise.resolve().then(() => options.credentials({ repository: input.repository, signal: operation.signal }))
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
    if (!token) throw agentDiagnostics.AGENT_R0751({ message: "GitHub authentication is not configured." })
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
      throw agentDiagnostics.AGENT_R0752({ message: "GitHub credentials that cannot identify their user must provide rateLimitKey." })
    }
    if (!response.ok) throw agentDiagnostics.AGENT_R0753({ message: `GitHub user request failed with ${response.status}.` })
    const body: unknown = await response.json()
    const id = isRuntimeRecord(body) ? body.id : undefined
    if (!hasRuntimeType(id, "number") || !Number.isSafeInteger(id) || id <= 0) {
      throw agentDiagnostics.AGENT_R0754({ message: "GitHub did not return a valid authenticated user ID." })
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
    const config = await credentials({ repository: input.repository, signal: input.signal })
    const appId = String(config.appId || "").trim()
    const installationId = String(config.installationId || "").trim()
    const appOwner = String(config.owner || "").trim().toLowerCase()
    const privateKey = secret(config.privateKey)?.trim().replace(/\\n/g, "\n") || ""
    const appValues = [appId, installationId, privateKey]
    const repositoryOwner = input.repository ? owner(input.repository) : undefined
    let token: string
    let rateLimitKey: string

    if (appValues.some(Boolean)) {
      if (!appValues.every(Boolean)) throw agentDiagnostics.AGENT_R0755({ message: "GitHub App appId, installationId, and privateKey must be configured together." })
      if (!appOwner) throw agentDiagnostics.AGENT_R0756({ message: "GitHub App owner must be configured with App credentials." })
      if (input.fallback || (repositoryOwner && repositoryOwner !== appOwner)) {
        token = await fallbackToken(config, input)
        rateLimitKey = await fallbackRateLimitKey(token, config.rateLimitKey, input)
      }
      else {
        const numericAppId = positiveInteger(appId, "GitHub App appId")
        const numericInstallationId = positiveInteger(installationId, "GitHub App installationId")
        rateLimitKey = `app:${numericAppId}:${numericInstallationId}`
        try {
          token = (await githubAppCredentials({ appId: numericAppId, privateKey, userAgent: options.userAgent })
            .installationToken(numericInstallationId, { refresh: input.refresh, signal: input.signal })).token
        }
        catch (error) {
          if (input.signal?.aborted) throw abortError(input.signal.reason)
          const status = codeHostErrorStatus(error)
          if (status !== undefined) throw agentDiagnostics.AGENT_R0757({ message: `GitHub App token request failed with ${status}.`, cause: error })
          if (error instanceof CodeHostResponseError) throw agentDiagnostics.AGENT_R0758({ message: "GitHub App token response did not include a token.", cause: error })
          throw error
        }
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
      GIT_CONFIG_VALUE_1: '!f() { if [ "$1" = get ]; then printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; fi; }; f',
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
      touchBudgetState(auth.rateLimitKey, Date.now())
      commands.set(auth.rateLimitKey, (commands.get(auth.rateLimitKey) ?? 0) + 1)
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
        touchBudgetState(auth.rateLimitKey, limit.checkedAt)
        limitVersions.set(auth.rateLimitKey, (limitVersions.get(auth.rateLimitKey) ?? 0) + 1)
        limits.set(auth.rateLimitKey, limit)
        throw new GitHubRateLimitError(input.repository ?? "this credential", limit, error)
      }
      throw error
    }
    finally {
      if (auth) {
        const count = commands.get(auth.rateLimitKey)
        if (count === 1) commands.delete(auth.rateLimitKey)
        else if (count !== undefined) commands.set(auth.rateLimitKey, count - 1)
      }
      operation.close()
    }
  }

  async function ensureGraphQLBudget(repository: string, options: GitHubGraphQLBudgetOptions): Promise<GitHubGraphQLReservation> {
    if (!Number.isSafeInteger(options.cost) || options.cost <= 0) throw agentDiagnostics.AGENT_R0759({ message: "GitHub GraphQL cost must be a positive integer." })
    const operation = controlledOperation(options)
    try {
      operation.signal.throwIfAborted()
      const auth = await scopedAccess({ repository, signal: operation.signal })
      const key = auth.rateLimitKey
      const now = Date.now()
      touchBudgetState(key, now)
      const cached = limits.get(key)
      const admit = (limit: GitHubGraphQLRateLimit): GitHubGraphQLReservation => {
        const available = limits.get(key) ?? limit
        if (available.resetAt > Date.now() && available.remaining - options.cost < reserve) {
          throw new GitHubRateLimitError(repository, available)
        }
        const reserved = { ...available, remaining: available.remaining - options.cost }
        const limitVersion = limitVersions.get(key) ?? 0
        const reservation: {
          admittedAtVersion: number
          expired?: boolean
          points: number
          resetAt: number
          rolledOver?: boolean
          submittedAtVersion?: number
        } = { admittedAtVersion: limitVersion, points: options.cost, resetAt: available.resetAt }
        const outstanding = reservations.get(key) ?? new Set()
        outstanding.add(reservation)
        reservations.set(key, outstanding)
        limits.set(key, reserved)
        let settled = false
        const settle = (actualCost: number, released: boolean = false) => {
          if (!Number.isSafeInteger(actualCost) || actualCost < 0) {
            throw agentDiagnostics.AGENT_R0760({ message: "GitHub GraphQL actual cost must be a non-negative integer." })
          }
          if (actualCost > options.cost) {
            throw agentDiagnostics.AGENT_R0761({ message: "GitHub GraphQL actual cost cannot exceed its reserved cost." })
          }
          if (settled) return
          if (!released && reservation.submittedAtVersion === undefined) {
            throw agentDiagnostics.AGENT_R0762({ message: "GitHub GraphQL reservations must be submitted before they are settled." })
          }
          if (released && reservation.submittedAtVersion !== undefined) {
            throw agentDiagnostics.AGENT_R0763({ message: "Submitted GitHub GraphQL reservations cannot be released." })
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
            const observationCeiling = observed?.resetAt === current.resetAt
              ? observed.version > (reservation.submittedAtVersion ?? observed.version)
                ? Math.max(0, observed.remaining - actualCost
                    - [...(outstanding ?? [])]
                      .filter(other => other.admittedAtVersion >= observed.version)
                      .reduce((points, other) => points + other.points, 0))
                : observed.remaining
              : undefined
            limits.set(key, {
              ...current,
              remaining: observationCeiling === undefined ? remaining : Math.min(remaining, observationCeiling),
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
            if (settled) throw agentDiagnostics.AGENT_R0764({ message: "Settled GitHub GraphQL reservations cannot be submitted." })
            if (reservation.expired) throw agentDiagnostics.AGENT_R0765({ message: "Expired GitHub GraphQL reservations cannot be submitted." })
            reservation.submittedAtVersion ??= limitVersions.get(key) ?? limitVersion
          },
        }
      }
      if (cached && cached.resetAt > now && (cached.remaining === 0 || now - cached.checkedAt < cacheMs)) return admit(cached)
      const pending = checks.get(key)
      if (pending) return admit(await waitForCaller(pending, { signal: operation.signal }))
      const checkVersion = limitVersions.get(key) ?? 0
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
          if ((limitVersions.get(key) ?? 0) !== checkVersion) {
            return limits.get(key) ?? limit
          }
          const nextVersion = (limitVersions.get(key) ?? 0) + 1
          const observed = observedLimits.get(key)
          observedLimits.set(key, {
            ...limit,
            remaining: observed?.resetAt === limit.resetAt ? Math.min(observed.remaining, limit.remaining) : limit.remaining,
            version: observed?.resetAt === limit.resetAt && observed.remaining <= limit.remaining
              ? observed.version
              : nextVersion,
          })
          const activeReservations = reservations.get(key)
          if (activeReservations) {
            for (const reservation of activeReservations) {
              if (reservation.resetAt === limit.resetAt) continue
              if (reservation.submittedAtVersion === undefined || reservation.rolledOver) {
                reservation.expired = true
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
          limitVersions.set(key, nextVersion)
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
    run: (checkout: GitHubHostCheckout) => Promise<T>,
    options: GitHubHostCheckoutOptions = {},
  ): Promise<T> {
    if (!/^[a-f0-9]{40}$/i.test(pullRequest.headSha)) throw agentDiagnostics.AGENT_R0766({ message: "A pull request headSha must be a full Git commit SHA." })
    for (const repository of [pullRequest.repository, pullRequest.headRepository]) {
      if (repository !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
        throw agentDiagnostics.AGENT_R0766({ message: "Expected a GitHub repository in owner/name form." })
      }
    }
    if (pullRequest.headRepository && !pullRequest.headRef) {
      throw agentDiagnostics.AGENT_R0766({ message: "A pull request headRef is required when headRepository is supplied." })
    }
    const checkout = await mkdtemp(join(tmpdir(), `vitehub-${pullRequest.repository.replace("/", "-")}-pr-${pullRequest.number}-`))
    const checkoutIdentity = await lstat(checkout, { bigint: true })
    const isCheckout = async (path: string) => {
      try {
        const identity = await lstat(path, { bigint: true })
        return identity.dev === checkoutIdentity.dev && identity.ino === checkoutIdentity.ino
      }
      catch {
        return false
      }
    }
    const cleanupCheckout = async () => {
      const parent = dirname(checkout)
      // Candidate paths are only hints. The worker pins its cwd first, then
      // validates that inode before touching any contents. Do not rename a
      // candidate: it may have been replaced since discovery.
      for (let attempt = 0; attempt < 3; attempt++) {
        const candidates = [checkout, ...(await readdir(parent)).map(entry => join(parent, entry))]
        for (const candidate of candidates) {
          if (!await isCheckout(candidate)) continue
          try {
            const result = await exec(process.execPath, ["--input-type=module", "--eval", `
              import { lstat, readdir, rm } from "node:fs/promises"
              const info = await lstat(".", { bigint: true })
              if (String(info.dev) === process.argv[1] && String(info.ino) === process.argv[2]) {
                for (const entry of await readdir(".")) {
                  await rm(entry, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 })
                }
                process.stdout.write("cleaned")
              }
            `, String(checkoutIdentity.dev), String(checkoutIdentity.ino)], { cwd: candidate, maxBuffer })
            if (result.stdout === "cleaned") {
              // Keep the empty inode: pathname removal could delete a replacement.
              return
            }
          }
          catch (error) {
            // A move before cwd resolution needs another discovery pass.
            // SAFETY: execFile rejects with an Error; its optional code identifies cwd resolution failures.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }
        }
      }
      throw new Error(`[vitehub] Could not locate disposable checkout for cleanup: ${checkout}`)
    }

    const operation = controlledOperation(options)
    try {
      const baseAuth = await access({
        refresh: true,
        repository: pullRequest.repository,
        signal: operation.signal,
      })
      const env = { ...process.env, ...baseAuth.env, GH_HOST: "github.com" }
      const commandOptions = { env, maxBuffer, signal: operation.signal }
      if (pullRequest.headRef) {
        await exec("git", ["check-ref-format", `refs/heads/${pullRequest.headRef}`], commandOptions)
        if (pullRequest.headRef.startsWith("-")) throw agentDiagnostics.AGENT_R0766({ message: "A pull request headRef cannot start with a dash." })
      }
      // Provider workspaces must be self-contained. A blobless partial clone
      // defers file objects to a lazy network fetch, which is unavailable to
      // isolated agent runs when they inspect a full PR diff.
      await exec("git", ["clone", "--no-checkout", "--", `https://github.com/${pullRequest.repository}.git`, checkout], commandOptions)
      if (pullRequest.headRef) {
        // Fetch the source branch: GitHub's synthetic pull refs can lag a push.
        const sourceRepository = pullRequest.headRepository ?? pullRequest.repository
        const sourceAuth = sourceRepository === pullRequest.repository ? baseAuth : await access({ refresh: true, repository: sourceRepository, signal: operation.signal })
        await exec("git", ["-C", checkout, "fetch", "--no-tags", "--", `https://github.com/${sourceRepository}.git`, `refs/heads/${pullRequest.headRef}`], { ...commandOptions, env: { ...env, ...sourceAuth.env } })
        await exec("git", ["-C", checkout, "-c", "core.hooksPath=/dev/null", "checkout", "-B", pullRequest.headRef, "FETCH_HEAD"], commandOptions)
      }
      else {
        await exec("git", ["-C", checkout, "fetch", "--no-tags", "--", "origin", pullRequest.headSha], commandOptions)
        await exec("git", ["-C", checkout, "-c", "core.hooksPath=/dev/null", "checkout", "--detach", "FETCH_HEAD"], commandOptions)
      }
      await exec("git", ["-C", checkout, "remote", "set-url", "origin", `https://github.com/${pullRequest.repository}.git`], commandOptions)
      const pushUrl = pullRequest.headRepository
        ? `https://github.com/${pullRequest.headRepository}.git`
        : "disabled://pull-request-head-repository-unavailable"
      await exec("git", ["-C", checkout, "remote", "set-url", "--push", "origin", pushUrl], commandOptions)
      if (pullRequest.headRepository) {
        if (!pullRequest.headRef) throw agentDiagnostics.AGENT_R0766({ message: "A pull request headRef is required when headRepository is supplied." })
        await exec("git", ["-C", checkout, "config", "remote.origin.push", `HEAD:refs/heads/${pullRequest.headRef}`], commandOptions)
      }
      const fetched = (await exec("git", ["-C", checkout, "rev-parse", "HEAD"], commandOptions)).stdout.trim()
      if (fetched !== pullRequest.headSha) throw agentDiagnostics.AGENT_R0767({ message: `Pull request head changed from ${pullRequest.headSha} to ${fetched}.` })
      operation.signal.throwIfAborted()
      const prepareWorkspace = async (target: string, options: { restoreInstructions?: boolean } = {}) => await prepareGitHubPullRequestWorkspace(checkout, target, { ...options, signal: operation.signal })
      let pushHead = pullRequest.headSha
      const commitRepair = async (target: string, input: GitHubRepairCommit, commitOptions?: { verifyDependencies?: boolean }) => await commitGitHubPullRequestWorkspace(target, input, { expectedHead: pushHead, signal: operation.signal, identity: env, verifyDependencies: commitOptions?.verifyDependencies })
      const push = async (target: string = checkout, options: { signal?: AbortSignal, beforePush?: (head?: string) => void | Promise<void>, afterPush?: (head: string) => void | Promise<void> } = {}) => {
        const signal = options.signal ? AbortSignal.any([operation.signal, options.signal]) : operation.signal
        signal.throwIfAborted()
        const expectedHead = pushHead
        if (!pullRequest.headRepository || !pullRequest.headRef) throw agentDiagnostics.AGENT_R0766({ message: "Pull request source repository and branch are required to push." })
        const readEnv = { ...process.env }
        delete readEnv.GH_TOKEN
        delete readEnv.GITHUB_TOKEN
        delete readEnv.GIT_DIR
        delete readEnv.GIT_WORK_TREE
        delete readEnv.GIT_INDEX_FILE
        delete readEnv.GIT_COMMON_DIR
        for (const key of Object.keys(readEnv)) if (key.startsWith("GIT_CONFIG_")) delete readEnv[key]
        readEnv.GIT_CONFIG_NOSYSTEM = "1"
        readEnv.GIT_CONFIG_GLOBAL = "/dev/null"
        const readOptions = { env: readEnv, maxBuffer, signal }
        const root = (await exec("git", ["-C", target, "rev-parse", "--show-toplevel"], readOptions)).stdout.trim()
        if (await realpath(root) !== await realpath(target)) throw agentDiagnostics.AGENT_R0766({ message: "Push target must be the root of its prepared Git checkout." })
        const head = (await exec("git", ["-C", target, "rev-parse", "HEAD"], readOptions)).stdout.trim()
        if (!/^[a-f0-9]{40}$/i.test(head)) throw agentDiagnostics.AGENT_R0766({ message: "Push target did not return a full Git commit SHA." })
        if (await realpath(target) !== await realpath(checkout)) {
          // Import without host credentials. Authenticated Git only reads our trusted clone's config.
          await exec("git", ["-C", checkout, "-c", "protocol.file.allow=always", "-c", "uploadpack.packObjectsHook=", "fetch", "--no-tags", "--", await realpath(target), head], readOptions)
        }
        await exec("git", ["-C", checkout, "merge-base", "--is-ancestor", expectedHead, head], { ...commandOptions, signal })
        const refreshed = await access({
          refresh: true,
          repository: pullRequest.headRepository,
          signal,
        })
        signal.throwIfAborted()
        await options.beforePush?.(head)
        await exec("git", ["-C", checkout, "-c", "core.hooksPath=/dev/null", "push", "--no-verify", `--force-with-lease=refs/heads/${pullRequest.headRef}:${expectedHead}`, "--", pushUrl, `${head}:refs/heads/${pullRequest.headRef}`], {
          env: { ...process.env, ...refreshed.env },
          maxBuffer,
          signal,
        })
        // Record the remote receipt before post-push cancellation checks. The
        // pre-push base fence must not reject an already published repair.
        pushHead = head
        await options.afterPush?.(head)
        signal.throwIfAborted()
        return head
      }
      return await checkoutScope.run({ ...baseAuth, path: checkout }, () => run({ ...baseAuth, path: checkout, prepareWorkspace, commitRepair, push, signal: operation.signal }))
    }
    finally {
      operation.close()
      // Cleanup is best effort. Preserve the callback result or error when
      // the checkout moved or filesystem discovery fails.
      await cleanupCheckout().catch(() => undefined)
    }
  }

  const host: GitHubHost = {
    identity() {
      return identity.login?.trim() || undefined
    },
    channel(channelOptions = {}) {
      return github({ ...channelOptions, app: host })
    },
    async environment() {
      const current = checkoutScope.getStore()
      if (!current) return (await access({ fallback: true })).env
      return { ...current.env, GIT_DIR: join(current.path, '.git'), GIT_WORK_TREE: '.' }
    },
    access,
    budget,
    command,
    ensureGraphQLBudget,
    isRateLimitError: (error: unknown) => error instanceof GitHubRateLimitError,
    withPullRequestCheckout,
  }
  return host
}
