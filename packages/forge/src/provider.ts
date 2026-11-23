import type { ForgeProvider } from "forges"
import type { GitHubProvider } from "forges/github"

import { conditionalFetch } from "./conditional.ts"
import { forgeDiagnostics } from "./error-diagnostics.ts"

import type { ForgeConditionalRequests } from "./conditional.ts"
import type { Diagnostic } from "nostics"

/** The Forges that ViteHub supports. */
export type ForgeKind = "github" | "gitlab" | "forgejo" | "gitea"

export interface ForgeConnection {
  forge: ForgeKind
  /** GitHub: API base. GitLab, Forgejo and Gitea: instance root. */
  baseUrl?: string
  /** Omitted: anonymous public reads. */
  token?: string
  /** Default secret for verifying Gitea webhook deliveries. */
  webhookSecret?: string
  readOnly?: boolean
  fetch?: typeof fetch
  /** Default "vitehub". */
  userAgent?: string
  /** Request timeout in milliseconds. Default 30000. */
  timeout?: number
  /**
   * Revalidate repeated authenticated GETs with `If-None-Match`, so an unchanged response comes back as a `304`
   * that GitHub does not count against the rate limit. Default: on for GitHub. `false` turns it off.
   */
  conditionalRequests?: boolean | ForgeConditionalRequests
}

/**
 * Create the library provider for one Forge. Internal to ViteHub packages: return it from a public API only
 * where the API owns the Forge credentials, such as `GitHubHost.forge()` in `@vite-hub/agent`.
 * A GitHub provider also has `graphql()`.
 */
export async function forgeProvider(connection: ForgeConnection & { forge: "github" }): Promise<GitHubProvider>
export async function forgeProvider(connection: ForgeConnection): Promise<ForgeProvider>
export async function forgeProvider(connection: ForgeConnection): Promise<ForgeProvider> {
  const auth = connection.token
    ? { type: "token" as const, token: connection.token }
    : { type: "anonymous" as const }
  const conditional = connection.conditionalRequests ?? connection.forge === "github"
  const fetcher = conditional
    ? conditionalFetch(connection.fetch ?? ((input, init) => globalThis.fetch(input, init)), conditional === true ? {} : conditional)
    : connection.fetch
  const options = {
    ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
    ...(fetcher ? { fetch: fetcher } : {}),
    userAgent: connection.userAgent ?? "vitehub",
    ...(connection.timeout === undefined ? {} : { timeout: connection.timeout }),
    ...(connection.readOnly === undefined ? {} : { readOnly: connection.readOnly }),
    auth,
  }
  switch (connection.forge) {
    case "github": {
      const { github } = await import("forges/github")
      return github(options)
    }
    case "gitlab": {
      const { gitlab } = await import("forges/gitlab")
      return gitlab(options)
    }
    case "forgejo": {
      const { forgejo } = await import("forges/forgejo")
      return forgejo(options)
    }
    case "gitea": {
      const { gitea } = await import("forges/gitea")
      const { webhookSecret } = connection
      return gitea({ ...options, ...(webhookSecret ? { webhookSecret } : {}) })
    }
  }
  throw forgeDiagnostics.FORGE_UNSUPPORTED()
}

/** A Forge response that succeeded but did not include the expected data: `FORGE_RESPONSE_INVALID`. */
export function forgeResponseError(problem: string): Diagnostic {
  return forgeDiagnostics.FORGE_RESPONSE_INVALID({ problem })
}

/** Whether a Forge response did not include the expected data. */
export function isForgeResponseError(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "FORGE_RESPONSE_INVALID"
}

export { forgeErrorStatus } from "@vite-hub/internal/forge"

/** The error that a cancelled Forge operation rejects with. */
export function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException("The operation was aborted.", "AbortError")
}

/** Reject with the abort reason when `signal` aborts before `promise` settles. */
export async function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal))
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
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
