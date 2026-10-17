import { github, type GitHubChannelOptions } from '../channels.ts'
import type { AgentChannelDefinition } from '../types.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdtemp, readdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { hasRuntimeType } from "../internal/runtime-type.ts"
import { ForgeResponseError, forgeErrorStatus, forgeGitAuthHeader, forgeGitCredentials, forgeProvider, githubAppCredentials, type GitHubProvider } from "@vite-hub/forge"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { prepareGitHubPullRequestWorkspace } from "./github-checkout.ts"
import { commitGitHubPullRequestWorkspace, type GitHubRepairCommit } from "./github-repair.ts"

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

export interface GitHubHostOptions {
  credentials: (context: GitHubHostCredentialContext) => GitHubHostCredentials | Promise<GitHubHostCredentials>
  /** A `fetch` for Forge requests, for tests and runtimes without a global one. */
  fetch?: typeof fetch
  identity?: { email?: string, login?: string }
  maxBuffer?: number
  /** Forge request timeout in milliseconds. Default 60000. */
  timeout?: number
  userAgent?: string
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

export interface GitHubHostForgeOptions extends GitHubHostCheckoutOptions {
  /** Repository whose credentials the provider uses; omitted for unscoped access. */
  repository?: string
}

export interface GitHubHostAccessOptions extends GitHubHostCheckoutOptions {
  fallback?: boolean
  refresh?: boolean
  repository?: string
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
          const status = forgeErrorStatus(error)
          if (status !== undefined) throw agentDiagnostics.AGENT_R0757({ message: `GitHub App request /app failed with ${status}.`, cause: error })
          if (error instanceof ForgeResponseError) throw agentDiagnostics.AGENT_R0757({ message: error.message, cause: error })
          throw error
        })
        const provider = await forgeProvider({ forge: "github", userAgent: app.userAgent })
        const user = await provider.users.get(login).catch(() => undefined)
        return { login, email: user?.id ? `${user.id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com` }
      })()
      identity.catch(() => { identity = undefined })
      return await identity
    },
  }
}

function tokenKey(token: string): string {
  return `token:${createHash("sha256").update(token).digest("base64url")}`
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
  const identity = options.identity ?? {}
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

  function fallbackToken(config: GitHubHostCredentials): string {
    const configured = secret(config.token)?.trim()
    if (!configured) throw agentDiagnostics.AGENT_R0751({ message: "GitHub authentication is not configured. Set VITEHUB_GITHUB_TOKEN or GitHub App credentials." })
    return configured
  }

  async function scopedAccess(input: GitHubHostAccessOptions): Promise<GitHubHostAccess & { credentialKey: string }> {
    const config = await credentials({ repository: input.repository, signal: input.signal })
    const appId = String(config.appId || "").trim()
    const installationId = String(config.installationId || "").trim()
    const appOwner = String(config.owner || "").trim().toLowerCase()
    const privateKey = secret(config.privateKey)?.trim().replace(/\\n/g, "\n") || ""
    const appValues = [appId, installationId, privateKey]
    const repositoryOwner = input.repository ? owner(input.repository) : undefined
    let token: string
    let credentialKey: string

    if (appValues.some(Boolean)) {
      if (!appValues.every(Boolean)) throw agentDiagnostics.AGENT_R0755({ message: "GitHub App appId, installationId, and privateKey must be configured together." })
      if (!appOwner) throw agentDiagnostics.AGENT_R0756({ message: "GitHub App owner must be configured with App credentials." })
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
            .installationToken(numericInstallationId, { refresh: input.refresh, signal: input.signal })).token
        }
        catch (error) {
          if (input.signal?.aborted) throw abortError(input.signal.reason)
          const status = forgeErrorStatus(error)
          if (status !== undefined) throw agentDiagnostics.AGENT_R0757({ message: `GitHub App token request failed with ${status}.`, cause: error })
          if (error instanceof ForgeResponseError) throw agentDiagnostics.AGENT_R0758({ message: "GitHub App token response did not include a token.", cause: error })
          throw error
        }
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
    return { env, credentialKey, token }
  }

  async function access(input: GitHubHostAccessOptions = {}): Promise<GitHubHostAccess> {
    const operation = controlledOperation(input)
    try {
      const { env, token } = await scopedAccess({ ...input, signal: operation.signal, timeout: undefined })
      return { env, token }
    }
    finally {
      operation.close()
    }
  }

  async function forge(input: GitHubHostForgeOptions = {}): Promise<GitHubProvider> {
    const operation = controlledOperation(input)
    try {
      const auth = await scopedAccess({ repository: input.repository, signal: operation.signal })
      return await forgeProvider({
        forge: "github",
        token: auth.token,
        fetch: observe(auth.credentialKey),
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
      const login = host.identity()
      return github({
        ...channelOptions,
        app: {
          token: async (_context, scope) => (await access(scope)).token,
          ...(login ? { identity: { login } } : {}),
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
