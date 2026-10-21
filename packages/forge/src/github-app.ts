import { createHash } from "node:crypto"

import type { ForgeProvider } from "forges"
import { forgeDiagnostics } from "./error-diagnostics.ts"
import { abortError, forgeErrorStatus, ForgeResponseError, withSignal } from "./provider.ts"

export interface GitHubAppCredentials {
  installationToken(
    installationId: number | string,
    options?: { refresh?: boolean, signal?: AbortSignal },
  ): Promise<{ token: string, expiresAt: Date }>
  /** GET /repos/{repository}/installation with the app JWT. */
  installation(repository: string, signal?: AbortSignal): Promise<number>
  /** GET /app. */
  app(signal?: AbortSignal): Promise<{ id: number, slug: string, login: string }>
}

export interface GitHubAppInput {
  appId: number | string
  privateKey: string
  baseUrl?: string
  fetch?: typeof fetch
  userAgent?: string
}

const appProviders = new Map<string, Promise<ForgeProvider>>()
// Weak keys keep token retention bounded by the 128 cached providers.
const installationTokens = new WeakMap<ForgeProvider, { token: string, expiresAt: Date }>()
const appProviderLimit = 128
const fetchIds = new WeakMap<typeof fetch, number>()
let nextFetchId = 0

function fetchId(fetcher: typeof fetch | undefined): number {
  if (!fetcher) return 0
  let id = fetchIds.get(fetcher)
  if (id === undefined) {
    id = ++nextFetchId
    fetchIds.set(fetcher, id)
  }
  return id
}

function appProviderKey(input: GitHubAppInput, installationId: string): string {
  return createHash("sha256")
    .update(`${input.baseUrl || "https://api.github.com"}\0${input.appId}\0${input.privateKey}\0${input.userAgent ?? ""}\0${fetchId(input.fetch)}\0${installationId}`)
    .digest("hex")
}

/**
 * One App provider per installation, so `refresh` replaces the token of that installation only.
 * App-level requests use the entry with an empty installation ID.
 */
function appProvider(input: GitHubAppInput, installationId = "", refresh = false): Promise<ForgeProvider> {
  const key = appProviderKey(input, installationId)
  if (refresh) appProviders.delete(key)
  const cached = appProviders.get(key)
  if (cached) return cached
  const pending = import("forges/github").then(({ github }) => github({
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    userAgent: input.userAgent ?? "vitehub",
    auth: { type: "app" as const, appId: input.appId, privateKey: input.privateKey },
  }).create())
  pending.catch(() => appProviders.delete(key))
  appProviders.set(key, pending)
  if (appProviders.size > appProviderLimit) appProviders.delete(appProviders.keys().next().value!)
  return pending
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * GitHub App credentials. App providers are cached per API base, App, private key, user agent,
 * fetch function, and installation, so installation tokens are minted once and reused until they expire.
 */
export function githubAppCredentials(input: GitHubAppInput): GitHubAppCredentials {
  return {
    async installationToken(installationId, options = {}) {
      const id = String(installationId)
      const provider = await withSignal(appProvider(input, id, options.refresh), options.signal)
      const cached = installationTokens.get(provider)
      if (cached && cached.expiresAt.getTime() > Date.now() + 60_000) return cached
      // installations.token() cannot forward a signal in the pinned forges version.
      // Keep JWT signing in the provider and pass cancellation through its transport.
      const response = await withSignal(provider.request<{ token?: string, expires_at: string }>(
        "POST", `/app/installations/${id}/access_tokens`, { signal: options.signal },
      ), options.signal)
      if (!response.data.token) throw new ForgeResponseError("GitHub App installation token response did not include token.")
      const details = { token: response.data.token, expiresAt: new Date(response.data.expires_at) }
      installationTokens.set(provider, details)
      return details
    },
    async installation(repository, signal) {
      const provider = await withSignal(appProvider(input), signal)
      const path = `/repos/${repository}/installation`
      try {
        const response = await provider.request<unknown>("GET", path, { signal })
        const id = positiveId(isRecord(response.data) ? response.data.id : undefined)
        if (!id) throw forgeDiagnostics.FORGE_R0001({ message: `GitHub App is not installed for ${repository}.` })
        return id
      }
      catch (error) {
        if (signal?.aborted) throw abortError(signal)
        const status = forgeErrorStatus(error)
        if (status === undefined) throw error
        throw forgeDiagnostics.FORGE_R0001({ message: `GitHub App request ${path} failed with ${status}.`, cause: error })
      }
    },
    async app(signal) {
      const provider = await withSignal(appProvider(input), signal)
      const response = await provider.request<unknown>("GET", "/app", { signal })
      const id = positiveId(isRecord(response.data) ? response.data.id : undefined)
      const slug = isRecord(response.data) && typeof response.data.slug === "string" ? response.data.slug : undefined
      if (!id) throw new ForgeResponseError("GitHub App metadata did not include an ID.")
      if (!slug) throw new ForgeResponseError("GitHub App response did not include a slug.")
      return { id, slug, login: `${slug}[bot]` }
    },
  }
}

/** Read a GitHub App private key from an inline value or a file path. Escaped "\\n" becomes a newline. */
export async function readGitHubAppPrivateKey(inline: string | undefined, path: string | undefined): Promise<string | undefined> {
  const value = inline?.trim()
  if (value) return value.replace(/\\n/g, "\n")
  if (!path) return undefined
  const { readFile } = await import(/* @vite-ignore */ "node:fs/promises")
  const file = (await readFile(path, "utf8")).trim()
  return file ? file.replace(/\\n/g, "\n") : undefined
}
