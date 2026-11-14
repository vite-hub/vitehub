import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"
import { isRuntimeDiagnostic } from "@vite-hub/runtime"

import type { Result } from "@vite-hub/runtime"
import type { ForgeProvider } from "forges"
import type { GitHubProvider } from "forges/github"

import { forgeEnv, readForgeEnv } from "./env.ts"
import { forgeErrors } from "./errors.ts"
import { githubAppCredentials, readGitHubAppPrivateKey } from "./github-app.ts"
import { githubInstallationFor, githubInstallationRouting } from "./github-installations.ts"
import { abortError, forgeErrorStatus, forgeProvider } from "./provider.ts"

import type { ForgeEnvField } from "./env.ts"
import type { GitHubAppCredentials } from "./github-app.ts"
import type { GitHubInstallationRouting } from "./github-installations.ts"
import type { ForgeKind } from "./provider.ts"

/** Where `useForge()` reads its env: a record such as `process.env`, or a lookup by variable name. */
export type ForgeEnvSource = Record<string, unknown> | ((name: string) => unknown)

export interface UseForgeOptions<TKind extends ForgeKind = "github"> {
  /** Default `"github"`. */
  forge?: TKind
  /**
   * GitHub: the API base, for GitHub Enterprise Server. GitLab and Forgejo: the instance root.
   * Default for GitLab and Forgejo: `VITEHUB_GITLAB_BASE_URL` or `VITEHUB_FORGEJO_BASE_URL`.
   */
  baseUrl?: string
  /** Default: the bindings of the active Cloudflare request, then `process.env`. */
  env?: ForgeEnvSource
  fetch?: typeof fetch
  /** Default `"vitehub"`. */
  userAgent?: string
  /**
   * `false` stops providers from revalidating repeated GETs with `If-None-Match`. Default: on for GitHub.
   * With a GitHub App, a cached response survives token rotation within the same installation.
   */
  conditionalRequests?: boolean
}

export interface ForgeCallOptions {
  /**
   * `owner/name`. With a GitHub App, the token is for the installation of the repository owner in
   * `VITEHUB_GITHUB_APP_INSTALLATIONS`, or `VITEHUB_GITHUB_INSTALLATION_ID` when the owner is `VITEHUB_GITHUB_APP_OWNER`.
   * Otherwise GitHub finds the installation that can reach the repository.
   */
  repository?: string
  /** Mint a new GitHub App installation token instead of the cached one. */
  refresh?: boolean
  signal?: AbortSignal
}

export interface ForgeToken {
  token: string
  /** When a GitHub App installation token expires. `undefined` for a configured token. */
  expiresAt: Date | undefined
}

/** The GitHub App that `useForge()` acts as. `login` is the bot user, such as `my-app[bot]`. */
export interface ForgeAppIdentity {
  id: number
  slug: string
  login: string
}

/** The `forges` provider of one Forge. A GitHub provider also has `graphql()`. */
export type ForgeProviderOf<TKind extends ForgeKind> = [TKind] extends ["github"] ? GitHubProvider : ForgeProvider

/** Codes of the errors that `useForge()` returns or throws. */
export type ForgeErrorCode =
  | "FORGE_APP_NOT_INSTALLED"
  | "FORGE_REQUEST_FAILED"
  | "FORGE_MISSING_ENV"
  | "FORGE_INVALID_ENV"
  | "FORGE_MISSING_INSTALLATION"
  | "FORGE_NOT_APP"

/** Runtime errors of a token request. */
export type ForgeTokenErrorCode = "FORGE_APP_NOT_INSTALLED" | "FORGE_REQUEST_FAILED"

/** One Forge identity, read from Server Env. */
export interface Forge<TKind extends ForgeKind = ForgeKind> {
  readonly kind: TKind
  /** `"app"`: GitHub App installation tokens. `"token"`: the configured token. */
  readonly auth: "app" | "token"
  readonly baseUrl: string | undefined
  /** A token for API calls, `git`, or `gh`. Installation tokens are cached until one minute before they expire. */
  token(options?: ForgeCallOptions): Promise<Result<ForgeToken, ForgeTokenErrorCode>>
  /** A `forges` provider that uses `token()`. Get a new one for each job: an installation token expires after one hour. */
  provider(options?: ForgeCallOptions): Promise<Result<ForgeProviderOf<TKind>, ForgeTokenErrorCode>>
  /** The GitHub App. Throws `FORGE_NOT_APP` when the Forge uses a token. */
  app(options?: { signal?: AbortSignal }): Promise<Result<ForgeAppIdentity, "FORGE_REQUEST_FAILED">>
}

interface GitHubAppConfig {
  appId: string
  installations: GitHubInstallationRouting
  privateKey: string | undefined
  privateKeyPath: string | undefined
}

function hostEnv(name: string): unknown {
  return getActiveCloudflareBinding<unknown>(name) ?? globalThis.process?.env?.[name]
}

function primaryName(field: ForgeEnvField): string {
  return field.names[0]
}

function readGitHubApp(env: ForgeEnvSource): GitHubAppConfig | undefined {
  const { github } = forgeEnv
  const appId = readForgeEnv(github.appId, env)
  const privateKey = readForgeEnv(github.privateKey, env)
  const privateKeyPath = readForgeEnv(github.privateKeyPath, env)
  if (!appId && !privateKey && !privateKeyPath) return undefined
  if (!appId) throw forgeErrors.FORGE_MISSING_ENV({ forge: "github", names: primaryName(github.appId) })
  if (!privateKey && !privateKeyPath) {
    throw forgeErrors.FORGE_MISSING_ENV({ forge: "github", names: `${primaryName(github.privateKey)} or ${primaryName(github.privateKeyPath)}` })
  }
  const installations = githubInstallationRouting({
    installationId: readForgeEnv(github.installationId, env),
    appOwner: readForgeEnv(github.appOwner, env),
    appInstallations: readForgeEnv(github.appInstallations, env),
  })
  return { appId, installations, privateKey, privateKeyPath }
}

function requestFailed(operation: string, cause: unknown, signal: AbortSignal | undefined) {
  if (signal?.aborted) throw abortError(signal)
  // A GitHub App lookup wraps the HTTP error in a diagnostic.
  const status = forgeErrorStatus(cause) ?? (isRuntimeDiagnostic(cause) ? forgeErrorStatus(cause.cause) : undefined)
  return forgeErrors.FORGE_REQUEST_FAILED({ cause, operation, ...(status === undefined ? {} : { status }) })
}

/**
 * The Forge identity of this deployment, read from the same Server Env as Channels, Workspaces and Sources.
 * GitHub uses a GitHub App when `VITEHUB_GITHUB_APP_ID` is set, and `VITEHUB_GITHUB_TOKEN` otherwise.
 * Throws a config error when the env has no credentials. Runtime operations return `[error, data]`.
 *
 * ```ts
 * const [error, provider] = await useForge().provider({ repository: "acme/web" })
 * ```
 */
export function useForge<TKind extends ForgeKind = "github">(options: UseForgeOptions<TKind> = {}): Forge<TKind> {
  // SAFETY: Without `forge`, TKind is its "github" default.
  const kind = (options.forge ?? "github") as TKind
  const env = options.env ?? hostEnv
  const fields: Record<ForgeKind, Record<string, ForgeEnvField>> = forgeEnv
  const githubApp = kind === "github" ? readGitHubApp(env) : undefined
  const configuredToken = githubApp ? undefined : readForgeEnv(forgeEnv[kind].token, env)
  const credential: { app: GitHubAppConfig } | { token: string } | undefined = githubApp
    ? { app: githubApp }
    : configuredToken ? { token: configuredToken } : undefined
  if (!credential) {
    const names = kind === "github"
      ? "VITEHUB_GITHUB_APP_ID with VITEHUB_GITHUB_PRIVATE_KEY or VITEHUB_GITHUB_PRIVATE_KEY_PATH, or VITEHUB_GITHUB_TOKEN"
      : primaryName(forgeEnv[kind].token)
    throw forgeErrors.FORGE_MISSING_ENV({ forge: kind, names })
  }
  const baseField = fields[kind].baseUrl
  const baseUrl = options.baseUrl ?? (baseField ? readForgeEnv(baseField, env) : undefined)
  const userAgent = options.userAgent ?? "vitehub"

  let credentials: Promise<GitHubAppCredentials> | undefined
  function appCredentials(config: GitHubAppConfig): Promise<GitHubAppCredentials> {
    credentials ??= readGitHubAppPrivateKey(config.privateKey, config.privateKeyPath).then(
      (privateKey) => {
        if (!privateKey) throw forgeErrors.FORGE_INVALID_ENV({ name: primaryName(forgeEnv.github.privateKeyPath), problem: `names an empty file: ${config.privateKeyPath}` })
        return githubAppCredentials({ appId: config.appId, privateKey, userAgent, ...(baseUrl ? { baseUrl } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) })
      },
      (cause: unknown) => {
        throw forgeErrors.FORGE_INVALID_ENV({ cause, name: primaryName(forgeEnv.github.privateKeyPath), problem: `names a file that cannot be read: ${config.privateKeyPath}` })
      },
    )
    credentials.catch(() => { credentials = undefined })
    return credentials
  }

  async function installationToken(config: GitHubAppConfig, call: ForgeCallOptions): Promise<Result<ForgeToken & { identity: string }, ForgeTokenErrorCode>> {
    const { repository, signal } = call
    const client = await appCredentials(config)
    let installation = githubInstallationFor(config.installations, repository)
    if (installation === undefined) {
      if (!repository) throw forgeErrors.FORGE_MISSING_INSTALLATION()
      try {
        installation = await client.installation(repository, signal)
      }
      catch (cause) {
        if (signal?.aborted) throw abortError(signal)
        // installation() throws FORGE_R0001 for a missing installation, with the HTTP error as its cause.
        const lookup = isRuntimeDiagnostic(cause) && cause.code === "FORGE_R0001"
        const status = lookup ? forgeErrorStatus(cause.cause) : undefined
        if (lookup && (status === undefined || status === 404)) return [forgeErrors.FORGE_APP_NOT_INSTALLED({ cause, repository }), undefined]
        return [requestFailed(`GET /repos/${repository}/installation`, cause, signal), undefined]
      }
    }
    try {
      const minted = await client.installationToken(installation, { signal, ...(call.refresh ? { refresh: true } : {}) })
      return [undefined, { token: minted.token, expiresAt: minted.expiresAt, identity: `app:${config.appId}:${installation}` }]
    }
    catch (cause) {
      return [requestFailed(`POST /app/installations/${installation}/access_tokens`, cause, signal), undefined]
    }
  }

  const forge: Forge<TKind> = {
    kind,
    auth: "app" in credential ? "app" : "token",
    baseUrl,
    async token(call = {}) {
      if (call.signal?.aborted) throw abortError(call.signal)
      if (!("app" in credential)) return [undefined, { token: credential.token, expiresAt: undefined }]
      const [error, minted] = await installationToken(credential.app, call)
      return error ? [error, undefined] : [undefined, { token: minted.token, expiresAt: minted.expiresAt }]
    },
    async provider(call = {}) {
      if (call.signal?.aborted) throw abortError(call.signal)
      const [error, minted] = "app" in credential
        ? await installationToken(credential.app, call)
        : [undefined, { token: credential.token, identity: undefined }]
      if (call.signal?.aborted) throw abortError(call.signal)
      if (error) return [error, undefined]
      const provider = await forgeProvider({
        forge: kind,
        token: minted.token,
        userAgent,
        ...(options.conditionalRequests === false
          ? { conditionalRequests: false }
          : minted.identity ? { conditionalRequests: { identity: minted.identity } } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
      if (call.signal?.aborted) throw abortError(call.signal)
      // SAFETY: forgeProvider() returns a GitHubProvider for "github", as its overloads declare.
      return [undefined, provider as ForgeProviderOf<TKind>]
    },
    async app(call = {}) {
      if (!("app" in credential)) throw forgeErrors.FORGE_NOT_APP()
      const client = await appCredentials(credential.app)
      try {
        return [undefined, await client.app(call.signal)]
      }
      catch (cause) {
        return [requestFailed("GET /app", cause, call.signal), undefined]
      }
    },
  }
  return forge
}
