import { github, type GitHubChannelOptions } from '@vite-hub/agent/channels'
import type { AgentChannelDefinition } from '@vite-hub/agent'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"

import { invariant } from "@vite-hub/internal/invariant"
import { presetsErrorDiagnostics } from "../error-diagnostics.ts"
import { hasRuntimeType } from "../internal/runtime-type.ts"
import { forgeErrorStatus, forgeGitAuthHeader, forgeGitCredentials, forgeProvider, githubAppCredentials, githubInstallationFor, isForgeResponseError, type GitHubAppCredentials, type GitHubAppDelivery, type GitHubAppRepository, type GitHubProvider } from "@vite-hub/forge"
import { prepareGitHubPullRequestWorkspace, preparePersistentGitHubPullRequestWorkspace, type GitHubWorkspaceReuse } from "./checkout.ts"
import { commitGitHubPullRequestWorkspace, type GitHubRepairCommit } from "./repair.ts"

const exec = promisify(execFile)
const rateLimitLimit = 256

export type GitHubHostSecret = string | { unseal: () => string }

export interface GitHubHostCredentials {
  appId?: number | string
  installationId?: number | string
  owner?: string
  privateKey?: GitHubHostSecret
  token?: GitHubHostSecret
}

export interface GitHubHostCredentialContext {
  /** Repository whose GitHub credentials are needed; omitted for unscoped access. */
  repository?: string
  signal: AbortSignal
}

/** The GitHub user or App bot that commits and comments for the host. */
export interface GitHubHostIdentity { appId?: number, email?: string, login?: string }

export interface GitHubHostOptions {
  credentials: (context: GitHubHostCredentialContext) => GitHubHostCredentials | Promise<GitHubHostCredentials>
  /** A `fetch` for Forge requests, for tests and runtimes without a global one. */
  fetch?: typeof fetch
  /**
   * Commit author and comment owner. Default: the GitHub App bot of the App credentials, such as
   * `my-app[bot]` with its noreply email. Set it for a token without an App.
   */
  identity?: GitHubHostIdentity
  maxBuffer?: number
  /** Forge request timeout in milliseconds. Default 60000. */
  timeout?: number
  userAgent?: string
  /**
   * `false` stops Forge providers from revalidating repeated GETs with `If-None-Match`. Default: on. Entries are
   * kept per App installation, so they survive the hourly token rotation, or per token without an App.
   */
  conditionalRequests?: boolean
}

export interface GitHubHostAccess {
  /**
   * Environment for `gh` and `git`: `GH_TOKEN`, `GITHUB_TOKEN`, and the commit identity. With a `repository`,
   * it also has the Git credentials for that repository in `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`.
   */
  env: Record<string, string>
  token: string
}

export interface GitHubHostPullRequest {
  /** Base branch. With it, `push()` tells `beforePush` whether every new commit outside the base is the host's. */
  baseRef?: string
  headRef?: string
  headRepository?: string
  headSha: string
  number: number
  repository: string
}

export interface GitHubHostCheckout extends GitHubHostAccess {
  path: string
  /**
   * Restore source instruction files only before the provider injects its instructions. For the
   * `persistent.work` directory, `reuse` keeps its ignored files when the tracked tree matches the
   * head, and the result says whether it did. `complete` checks the whole head out into another
   * directory the caller owns, the way the `persistent.work` directory is prepared.
   */
  prepareWorkspace(target: string, options?: { restoreInstructions?: boolean, reuse?: boolean, reason?: string, complete?: boolean }): Promise<{ reused: boolean, reason: GitHubWorkspaceReuse } | void>
  commitRepair(target: string, input: GitHubRepairCommit, options?: { verifyDependencies?: boolean }): Promise<string>
  push(target?: string, options?: { signal?: AbortSignal, beforePush?: (head?: string, lineage?: GitHubHostPushLineage) => void | Promise<void>, afterPush?: (head: string) => void | Promise<void> }): Promise<string>
  signal: AbortSignal
}

/** How a pushed head relates to the head it replaces. */
export interface GitHubHostPushLineage {
  /** The pull request head that the push replaces. The pushed head descends from it. */
  parent: string
  /**
   * Every commit that the push adds, apart from commits on the base branch, is one that `commitRepair()`
   * made in this checkout. A provider that fetches and merges someone else's commits makes this `false`.
   */
  hostOnly: boolean
}

export interface GitHubHostCheckoutOptions {
  signal?: AbortSignal
  timeout?: number
  /**
   * Keep the host clone in `checkout` after the callback and fetch into it next time instead of
   * cloning. `work` is the provider workspace that `prepareWorkspace` keeps between calls.
   */
  persistent?: { checkout: string, work: string }
}

export interface GitHubHostForgeOptions extends GitHubHostCheckoutOptions {
  /** Repository whose credentials the provider uses; omitted for unscoped access. */
  repository?: string
}

export interface GitHubHostAccessOptions extends GitHubHostCheckoutOptions {
  fallback?: boolean
  refresh?: boolean
  /** Mint a new App installation token when the cached one expires within this many milliseconds. */
  minLifetime?: number
  repository?: string
  /**
   * Repository whose App installation mints the token, when it is not `repository`. Git still sends the
   * token only to `repository`. A fork without the App uses its base repository's installation, whose
   * token may push to the fork's branch while its author allows edits by maintainers.
   */
  installationRepository?: string
}

/** A GitHub rate limit that the response headers of this host's Forge requests reported. */
export interface GitHubHostRateLimit {
  /** The GitHub rate limit resource, for example `core` or `graphql`. */
  resource: string
  limit: number
  remaining: number
  resetAt: number
  checkedAt: number
}

export interface GitHubHost {
  channel(options?: Omit<GitHubChannelOptions, 'app'>): AgentChannelDefinition
  /** Return the verified login configured for this host, when available. */
  identity(): string | undefined
  /** Immutable GitHub App ID for managed activity ownership. */
  appId?(): number | undefined
  /** Resolve credentials and Git binding for the current checkout callback. */
  environment(): Promise<Record<string, string>>
  access(input?: GitHubHostAccessOptions): Promise<GitHubHostAccess>
  /**
   * A `forges` GitHub provider with the repository's credentials. It has every Forge verb and `graphql()`.
   * Create one for each operation: installation tokens expire after one hour.
   */
  forge(input?: GitHubHostForgeOptions): Promise<GitHubProvider>
  /** The most constrained rate limit that recent Forge responses reported, or undefined before the first response. */
  rateLimit(): GitHubHostRateLimit | undefined
  withPullRequestCheckout<T>(pullRequest: GitHubHostPullRequest, run: (checkout: GitHubHostCheckout) => Promise<T>, options?: GitHubHostCheckoutOptions): Promise<T>
}

function secret(value: GitHubHostSecret | undefined): string | undefined {
  return hasRuntimeType(value, "string") ? value : value?.unseal()
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw presetsErrorDiagnostics.PRESETS_GITHUB_APP_NUMBER_INVALID({ name })
  return number
}

export interface GitHubAppEnvironment {
  appId: number
  privateKey: string
  /** Fixed installation of `owner`, which it needs. Repositories of other owners use `installations` or discovery. */
  installationId?: number
  /** Repository owner of `installationId`. */
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
  if (app.installationId !== undefined && !app.owner) throw presetsErrorDiagnostics.PRESETS_GITHUB_APP_OWNER_MISSING()
  const routing = {
    ...(app.installationId === undefined ? {} : { installationId: app.installationId }),
    ...(app.owner ? { owner: app.owner.toLowerCase() } : {}),
    installations: Object.fromEntries(Object.entries(app.installations ?? {}).map(([name, id]) => [name.toLowerCase(), id])),
  }
  const installations = new Map<string, number>()
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
      const installationId = githubInstallationFor(routing, context.repository) ?? await installation(context.repository, context.signal)
      return { appId: app.appId, installationId, owner: owner(context.repository), privateKey: app.privateKey, token: app.token }
    },
    /** Every repository that the App's installations can access. */
    repositories: (signal?: AbortSignal): Promise<GitHubAppRepository[]> => client.repositories(signal),
    /** Failed App webhook deliveries since `since` that no later attempt delivered, oldest first. */
    failedDeliveries: (since: number, signal?: AbortSignal): Promise<GitHubAppDelivery[]> => client.failedDeliveries(since, signal),
    /** Sends one App webhook delivery again. */
    redeliver: (id: string, signal?: AbortSignal): Promise<void> => client.redeliver(id, signal),
    /** The App bot's login and noreply email, used as the commit author. */
    async identity(): Promise<Required<GitHubHostIdentity>> {
      return await appIdentity(client)
    },
  }
}

function tokenKey(token: string): string {
  return `token:${createHash("sha256").update(token).digest("base64url")}`
}

/** The App's bot login, its immutable ID, and its noreply commit email. `@vite-hub/forge` caches it per App. */
async function appIdentity(client: GitHubAppCredentials, signal?: AbortSignal): Promise<Required<GitHubHostIdentity>> {
  const { id: appId, login, email } = await client.app(signal).catch((error: unknown) => {
    if (signal?.aborted) throw abortError(signal.reason)
    const status = forgeErrorStatus(error)
    if (status !== undefined) throw presetsErrorDiagnostics.PRESETS_GITHUB_APP_REQUEST_FAILED({ status, cause: error })
    if (isForgeResponseError(error)) throw presetsErrorDiagnostics.PRESETS_GITHUB_APP_RESPONSE_INVALID({ cause: error })
    throw error
  })
  return { appId, login, email }
}

/** The App lookup or token request for a repository answered 404: the App is not installed there. */
function notInstalled(error: unknown): boolean {
  for (let cause = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth++) {
    if (forgeErrorStatus(cause) === 404) return true
  }
  return false
}

function owner(repository: string): string {
  return repository.split("/", 1)[0]!.toLowerCase()
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

export function createGitHubHost(options: GitHubHostOptions): GitHubHost {
  const checkoutScope = new AsyncLocalStorage<GitHubHostAccess & { path: string }>()
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024
  // Without a configured identity, the host commits and comments as the bot of its App credentials.
  let appBot: Required<GitHubHostIdentity> | undefined
  const rateLimits = new Map<string, GitHubHostRateLimit>()

  /** Record the rate limit headers of each Forge response, keyed by credential and resource. */
  function observe(credentialKey: string): typeof fetch {
    const send = options.fetch ?? globalThis.fetch
    return async (input, init) => {
      const response = await send(input, init)
      const limit = Number(response.headers.get("x-ratelimit-limit"))
      const remaining = Number(response.headers.get("x-ratelimit-remaining"))
      const reset = Number(response.headers.get("x-ratelimit-reset"))
      if (response.headers.has("x-ratelimit-remaining") && Number.isSafeInteger(limit) && Number.isSafeInteger(remaining) && Number.isSafeInteger(reset)) {
        const resource = response.headers.get("x-ratelimit-resource") || "core"
        const key = `${credentialKey}\0${resource}`
        rateLimits.delete(key)
        rateLimits.set(key, { resource, limit, remaining, resetAt: reset * 1_000, checkedAt: Date.now() })
        if (rateLimits.size > rateLimitLimit) rateLimits.delete(rateLimits.keys().next().value!)
      }
      return response
    }
  }

  function rateLimit(): GitHubHostRateLimit | undefined {
    const now = Date.now()
    const current = [...rateLimits.values()].filter(limit => limit.resetAt > now)
    return current.sort((left, right) => left.remaining / Math.max(left.limit, 1) - right.remaining / Math.max(right.limit, 1))[0]
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

  async function appBotIdentity(appId: number, privateKey: string, signal?: AbortSignal): Promise<Required<GitHubHostIdentity>> {
    appBot = await appIdentity(githubAppCredentials({ appId, privateKey, userAgent: options.userAgent }), signal)
    return appBot
  }

  function fallbackToken(config: GitHubHostCredentials): string {
    const configured = secret(config.token)?.trim()
    if (!configured) throw presetsErrorDiagnostics.PRESETS_GITHUB_AUTH_MISSING()
    return configured
  }

  /** `commits: false` is for API calls only: they need no commit identity, so the App's identity is not read. */
  async function scopedAccess(input: GitHubHostAccessOptions, commits = true) {
    const installationRepository = input.installationRepository ?? input.repository
    const config = await credentials({ repository: installationRepository, signal: input.signal })
    const appId = String(config.appId || "").trim()
    const installationId = String(config.installationId || "").trim()
    const appOwner = String(config.owner || "").trim().toLowerCase()
    const privateKey = secret(config.privateKey)?.trim().replace(/\\n/g, "\n") || ""
    const appValues = [appId, installationId, privateKey]
    const repositoryOwner = installationRepository ? owner(installationRepository) : undefined
    let token: string
    let credentialKey: string
    let identity = options.identity ?? {}

    if (appValues.some(Boolean)) {
      if (!appValues.every(Boolean)) throw presetsErrorDiagnostics.PRESETS_GITHUB_APP_CREDENTIALS_INCOMPLETE()
      if (!appOwner) throw presetsErrorDiagnostics.PRESETS_GITHUB_HOST_APP_OWNER_MISSING()
      if (input.fallback || (repositoryOwner && repositoryOwner !== appOwner)) {
        token = fallbackToken(config)
        credentialKey = tokenKey(token)
      }
      else {
        const numericAppId = positiveInteger(appId, "GitHub App appId")
        const numericInstallationId = positiveInteger(installationId, "GitHub App installationId")
        credentialKey = `app:${numericAppId}:${numericInstallationId}`
        try {
          token = (await githubAppCredentials({ appId: numericAppId, privateKey, userAgent: options.userAgent })
            .installationToken(numericInstallationId, { refresh: input.refresh, minLifetime: input.minLifetime, signal: input.signal })).token
        }
        catch (error) {
          if (input.signal?.aborted) throw abortError(input.signal.reason)
          const status = forgeErrorStatus(error)
          if (status !== undefined) throw presetsErrorDiagnostics.PRESETS_GITHUB_APP_TOKEN_FAILED({ status, cause: error })
          if (isForgeResponseError(error)) throw presetsErrorDiagnostics.PRESETS_GITHUB_APP_TOKEN_MISSING({ cause: error })
          throw error
        }
        if (commits && !options.identity) identity = await appBotIdentity(numericAppId, privateKey, input.signal)
      }
    }
    else {
      token = fallbackToken(config)
      credentialKey = tokenKey(token)
    }

    // Git sends the token only to the scoped repository. An empty helper stops Git from asking an ambient credential helper.
    const header = input.repository
      ? forgeGitAuthHeader(forgeGitCredentials({ forge: "github", repository: input.repository, token }))
      : undefined
    const env: Record<string, string> = {
      GH_HOST: "github.com",
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      GIT_CONFIG_COUNT: header ? "2" : "1",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_VALUE_0: "",
      GIT_TERMINAL_PROMPT: "0",
    }
    if (header) {
      env.GIT_CONFIG_KEY_1 = header.key
      env.GIT_CONFIG_VALUE_1 = header.value
    }
    if (identity.login) {
      env.GIT_AUTHOR_NAME = identity.login
      env.GIT_COMMITTER_NAME = identity.login
    }
    if (identity.email) {
      env.GIT_AUTHOR_EMAIL = identity.email
      env.GIT_COMMITTER_EMAIL = identity.email
    }
    return { env, credentialKey, token, identity }
  }

  async function commitAccess(input: GitHubHostAccessOptions) {
    const operation = controlledOperation(input)
    try {
      return await scopedAccess({ ...input, signal: operation.signal, timeout: undefined })
    }
    finally {
      operation.close()
    }
  }

  async function access(input: GitHubHostAccessOptions = {}): Promise<GitHubHostAccess> {
    const { env, token } = await commitAccess(input)
    return { env, token }
  }

  /**
   * Access to a fork head: the fork's own App installation, or the base repository's when the App is not
   * installed on the fork. The base's token pushes to the fork only while its author allows edits by maintainers.
   */
  async function headAccess(input: GitHubHostAccessOptions, base: string): Promise<GitHubHostAccess> {
    if (!input.repository || input.repository === base) return await access(input)
    try {
      return await access(input)
    }
    catch (error) {
      if (input.signal?.aborted || !notInstalled(error)) throw error
      return await access({ ...input, installationRepository: base })
    }
  }

  async function forge(input: GitHubHostForgeOptions = {}): Promise<GitHubProvider> {
    const operation = controlledOperation(input)
    try {
      const auth = await scopedAccess({ repository: input.repository, signal: operation.signal }, false)
      return await forgeProvider({
        forge: "github",
        token: auth.token,
        fetch: observe(auth.credentialKey),
        conditionalRequests: options.conditionalRequests === false ? false : { identity: auth.credentialKey },
        timeout: options.timeout ?? 60_000,
        userAgent: options.userAgent,
      })
    }
    finally {
      operation.close()
    }
  }

  async function withPullRequestCheckout<T>(
    pullRequest: GitHubHostPullRequest,
    run: (checkout: GitHubHostCheckout) => Promise<T>,
    options: GitHubHostCheckoutOptions = {},
  ): Promise<T> {
    if (!/^[a-f0-9]{40}$/i.test(pullRequest.headSha)) throw presetsErrorDiagnostics.PRESETS_PULL_REQUEST_HEAD_SHA_INVALID()
    for (const repository of [pullRequest.repository, pullRequest.headRepository]) {
      if (repository !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
        throw presetsErrorDiagnostics.PRESETS_GITHUB_REPOSITORY_INVALID()
      }
    }
    if (pullRequest.headRepository && !pullRequest.headRef) {
      throw presetsErrorDiagnostics.PRESETS_PULL_REQUEST_HEAD_REF_MISSING()
    }
    const persistent = options.persistent
    if (persistent) await mkdir(persistent.checkout, { recursive: true })
    const checkout = persistent ? await realpath(persistent.checkout) : await mkdtemp(join(tmpdir(), `vitehub-${pullRequest.repository.replace("/", "-")}-pr-${pullRequest.number}-`))
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
      throw presetsErrorDiagnostics.PRESETS_CHECKOUT_CLEANUP_FAILED({ checkout })
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
        if (pullRequest.headRef.startsWith("-")) throw presetsErrorDiagnostics.PRESETS_PULL_REQUEST_HEAD_REF_INVALID()
      }
      const cloneUrl = `https://github.com/${pullRequest.repository}.git`
      // A kept clone is reused only when its own .git directory belongs to this repository;
      // `git -C` alone would find a parent repository.
      let reuseClone = Boolean(persistent)
        && Boolean((await lstat(join(checkout, ".git")).catch(() => undefined))?.isDirectory())
        && await exec("git", ["-C", checkout, "rev-parse", "--absolute-git-dir"], commandOptions)
          .then(async result => result.stdout.trim() === await realpath(join(checkout, ".git")), () => false)
        && await exec("git", ["-C", checkout, "config", "--local", "--get", "remote.origin.url"], commandOptions)
          .then(result => result.stdout.trim() === cloneUrl, () => false)
      // Fetch-time gc must not run detached while a provider workspace copies this .git directory.
      const fetchConfig = persistent ? ["-c", "gc.autoDetach=false", "-c", "maintenance.autoDetach=false"] : []
      const checkoutMode = persistent ? ["--force"] : []
      for (;;) {
        try {
          if (!reuseClone) {
            if (persistent) await Promise.all((await readdir(checkout)).map(entry => rm(join(checkout, entry), { recursive: true, force: true, maxRetries: 3 })))
            // Provider workspaces must be self-contained. A blobless partial clone
            // defers file objects to a lazy network fetch, which is unavailable to
            // isolated agent runs when they inspect a full PR diff.
            await exec("git", ["clone", "--no-checkout", "--", cloneUrl, checkout], commandOptions)
          }
          if (pullRequest.headRef) {
            // Fetch the source branch: GitHub's synthetic pull refs can lag a push.
            const sourceRepository = pullRequest.headRepository ?? pullRequest.repository
            const sourceAuth = sourceRepository === pullRequest.repository ? baseAuth : await headAccess({ refresh: true, repository: sourceRepository, signal: operation.signal }, pullRequest.repository)
            await exec("git", ["-C", checkout, ...fetchConfig, "fetch", "--no-tags", "--", `https://github.com/${sourceRepository}.git`, `refs/heads/${pullRequest.headRef}`], { ...commandOptions, env: { ...env, ...sourceAuth.env } })
            await exec("git", ["-C", checkout, "-c", "core.hooksPath=/dev/null", "checkout", ...checkoutMode, "-B", pullRequest.headRef, "FETCH_HEAD"], commandOptions)
          }
          else {
            await exec("git", ["-C", checkout, ...fetchConfig, "fetch", "--no-tags", "--", "origin", pullRequest.headSha], commandOptions)
            await exec("git", ["-C", checkout, "-c", "core.hooksPath=/dev/null", "checkout", ...checkoutMode, "--detach", "FETCH_HEAD"], commandOptions)
          }
          if (persistent) await exec("git", ["-C", checkout, "clean", "-ffdxq"], commandOptions)
          break
        }
        catch (error) {
          // A kept clone that Git cannot update, such as one with a stale lock or a broken ref, is cloned again.
          if (!reuseClone || operation.signal.aborted) throw error
          reuseClone = false
        }
      }
      await exec("git", ["-C", checkout, "remote", "set-url", "origin", `https://github.com/${pullRequest.repository}.git`], commandOptions)
      const pushUrl = pullRequest.headRepository
        ? `https://github.com/${pullRequest.headRepository}.git`
        : "disabled://pull-request-head-repository-unavailable"
      await exec("git", ["-C", checkout, "remote", "set-url", "--push", "origin", pushUrl], commandOptions)
      if (pullRequest.headRepository) {
        invariant(pullRequest.headRef, "withPullRequestCheckout() rejects a headRepository without a headRef before the clone")
        await exec("git", ["-C", checkout, "config", "remote.origin.push", `HEAD:refs/heads/${pullRequest.headRef}`], commandOptions)
      }
      const fetched = (await exec("git", ["-C", checkout, "rev-parse", "HEAD"], commandOptions)).stdout.trim()
      if (fetched !== pullRequest.headSha) throw presetsErrorDiagnostics.PRESETS_PULL_REQUEST_HEAD_CHANGED({ expected: pullRequest.headSha, actual: fetched })
      operation.signal.throwIfAborted()
      const prepareWorkspace = async (target: string, options: { restoreInstructions?: boolean, reuse?: boolean, reason?: string, complete?: boolean } = {}) => options.complete || persistent && resolve(target) === resolve(persistent.work)
        ? await preparePersistentGitHubPullRequestWorkspace(checkout, target, { reuse: options.reuse, reason: options.reason, signal: operation.signal })
        : await prepareGitHubPullRequestWorkspace(checkout, target, { restoreInstructions: options.restoreInstructions, signal: operation.signal })
      let pushHead = pullRequest.headSha
      // Commits that commitRepair() created here. A pushed head whose new commits are all in this set is the host's own work.
      const hostCommits = new Set<string>()
      const commitRepair = async (target: string, input: GitHubRepairCommit, commitOptions?: { verifyDependencies?: boolean }) => {
        const before = (await exec("git", ["-C", target, "rev-parse", "HEAD"], commandOptions)).stdout.trim()
        const head = await commitGitHubPullRequestWorkspace(target, input, { expectedHead: pushHead, signal: operation.signal, identity: env, verifyDependencies: commitOptions?.verifyDependencies })
        if (head !== before) hostCommits.add(head)
        return head
      }
      const hostOnly = async (head: string, parent: string, signal: AbortSignal): Promise<boolean> => {
        if (!hostCommits.size) return false
        let base: string[] = []
        if (pullRequest.baseRef) {
          try {
            await exec("git", ["-C", checkout, ...fetchConfig, "fetch", "--no-tags", "--", "origin", `refs/heads/${pullRequest.baseRef}`], { ...commandOptions, signal })
            base = ["^FETCH_HEAD"]
          }
          catch {
            if (signal.aborted) throw abortError(signal.reason)
          }
        }
        const added = (await exec("git", ["-C", checkout, "rev-list", head, `^${parent}`, ...base], { ...commandOptions, signal })).stdout.split("\n").filter(Boolean)
        return added.length > 0 && added.every(commit => hostCommits.has(commit))
      }
      const push = async (target: string = checkout, options: { signal?: AbortSignal, beforePush?: (head?: string, lineage?: GitHubHostPushLineage) => void | Promise<void>, afterPush?: (head: string) => void | Promise<void> } = {}) => {
        const signal = options.signal ? AbortSignal.any([operation.signal, options.signal]) : operation.signal
        signal.throwIfAborted()
        const expectedHead = pushHead
        if (!pullRequest.headRepository || !pullRequest.headRef) throw presetsErrorDiagnostics.PRESETS_PULL_REQUEST_PUSH_TARGET_MISSING()
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
        if (await realpath(root) !== await realpath(target)) throw presetsErrorDiagnostics.PRESETS_PUSH_TARGET_INVALID()
        const head = (await exec("git", ["-C", target, "rev-parse", "HEAD"], readOptions)).stdout.trim()
        if (!/^[a-f0-9]{40}$/i.test(head)) throw presetsErrorDiagnostics.PRESETS_PUSH_TARGET_HEAD_INVALID()
        if (await realpath(target) !== await realpath(checkout)) {
          // Import without host credentials. Authenticated Git only reads our trusted clone's config.
          await exec("git", ["-C", checkout, "-c", "protocol.file.allow=always", "-c", "uploadpack.packObjectsHook=", "fetch", "--no-tags", "--", await realpath(target), head], readOptions)
        }
        await exec("git", ["-C", checkout, "merge-base", "--is-ancestor", expectedHead, head], { ...commandOptions, signal })
        const refreshed = await headAccess({ refresh: true, repository: pullRequest.headRepository, signal }, pullRequest.repository)
        signal.throwIfAborted()
        await options.beforePush?.(head, { parent: expectedHead, hostOnly: await hostOnly(head, expectedHead, signal) })
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
      if (!persistent) await cleanupCheckout().catch(() => undefined)
    }
  }

  const host: GitHubHost = {
    identity() {
      return (options.identity ?? appBot)?.login?.trim() || undefined
    },
    appId() {
      return (options.identity ?? appBot)?.appId
    },
    channel(channelOptions = {}) {
      return github({
        ...channelOptions,
        app: {
          token: async (_context, scope) => {
            const { token, identity: { login, appId, email } } = await commitAccess(scope)
            const name = login?.trim()
            return { token, identity: name ? { login: name, appId, email } : undefined }
          },
        },
      })
    },
    async environment() {
      const current = checkoutScope.getStore()
      if (!current) return (await access({ fallback: true })).env
      return { ...current.env, GIT_DIR: join(current.path, '.git'), GIT_WORK_TREE: '.' }
    },
    access,
    forge,
    rateLimit,
    withPullRequestCheckout,
  }
  return host
}
