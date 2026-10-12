import { createHash } from "node:crypto"

import type { ForgeProvider } from "forges"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"

export type CodeHostKind = "github" | "gitlab" | "forgejo"

export interface CodeHostConnection {
  host: CodeHostKind
  /** GitHub: API base. GitLab and Forgejo: instance root. */
  baseUrl?: string
  /** Omitted: anonymous public reads. */
  token?: string
  readOnly?: boolean
  fetch?: typeof fetch
  /** Default "vitehub". */
  userAgent?: string
}

/** Create the library provider for one Code Host. Internal only: never return it from a public API. */
export async function codeHostProvider(connection: CodeHostConnection): Promise<ForgeProvider> {
  const auth = connection.token
    ? { type: "token" as const, token: connection.token }
    : { type: "anonymous" as const }
  const options = {
    ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
    ...(connection.fetch ? { fetch: connection.fetch } : {}),
    userAgent: connection.userAgent ?? "vitehub",
    ...(connection.readOnly === undefined ? {} : { readOnly: connection.readOnly }),
    auth,
  }
  switch (connection.host) {
    case "github": {
      const { github } = await import("forges/github")
      return github(options).create()
    }
    case "gitlab": {
      const { gitlab } = await import("forges/gitlab")
      return gitlab(options).create()
    }
    case "forgejo": {
      const { forgejo } = await import("forges/forgejo")
      return forgejo(options).create()
    }
  }
  throw new Error("Unsupported Code Host.")
}

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

interface GitHubAppInput {
  appId: number | string
  privateKey: string
  baseUrl?: string
  fetch?: typeof fetch
  userAgent?: string
}

/** A Code Host response that succeeded but did not include the expected data. */
export class CodeHostResponseError extends Error {
  override name = "CodeHostResponseError"
}

/** The HTTP status of a failed Code Host request, or undefined for other errors. */
export function codeHostErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || !isRuntimeRecord(error)) return undefined
  return hasRuntimeType(error.status, "number") ? error.status : undefined
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

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException("The operation was aborted.", "AbortError")
}

export async function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise
  if (signal.aborted) throw abortError(signal)
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal))
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

function positiveId(value: unknown): number | undefined {
  return hasRuntimeType(value, "number") && Number.isSafeInteger(value) && value > 0 ? value : undefined
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
      if (!response.data.token) throw new CodeHostResponseError("GitHub App installation token response did not include token.")
      const details = { token: response.data.token, expiresAt: new Date(response.data.expires_at) }
      installationTokens.set(provider, details)
      return details
    },
    async installation(repository, signal) {
      const provider = await withSignal(appProvider(input), signal)
      const path = `/repos/${repository}/installation`
      try {
        const response = await provider.request<unknown>("GET", path, { signal })
        const id = positiveId(isRuntimeRecord(response.data) ? response.data.id : undefined)
        if (!id) throw agentDiagnostics.AGENT_R0757({ message: `GitHub App is not installed for ${repository}.` })
        return id
      }
      catch (error) {
        if (signal?.aborted) throw abortError(signal)
        const status = codeHostErrorStatus(error)
        if (status === undefined) throw error
        throw agentDiagnostics.AGENT_R0757({ message: `GitHub App request ${path} failed with ${status}.`, cause: error })
      }
    },
    async app(signal) {
      const provider = await withSignal(appProvider(input), signal)
      const response = await provider.request<unknown>("GET", "/app", { signal })
      const id = positiveId(isRuntimeRecord(response.data) ? response.data.id : undefined)
      const slug = isRuntimeRecord(response.data) && hasRuntimeType(response.data.slug, "string") ? response.data.slug : undefined
      if (!id) throw new CodeHostResponseError("GitHub App metadata did not include an ID.")
      if (!slug) throw new CodeHostResponseError("GitHub App response did not include a slug.")
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
