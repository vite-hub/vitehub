import type { ForgeProvider, RepoRef } from "forges"
import type { GitHubProvider } from "forges/github"

import { forgeDiagnostics } from "../error-diagnostics.ts"

/** Narrow a provider to GitHub, or throw `FORGE_R0006` for a GitHub-only helper. */
export function requireGitHub(provider: ForgeProvider, operation: string): GitHubProvider {
  if (isGitHubProvider(provider)) return provider
  throw forgeDiagnostics.FORGE_R0006({ message: `${operation} is available only on GitHub. ${provider.forge} has no equivalent.` })
}

function isGitHubProvider(provider: ForgeProvider): provider is GitHubProvider {
  return provider.forge === "github" && "graphql" in provider && typeof provider.graphql === "function"
}

export function repositoryPath(repo: RepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The next page of a GitHub listing from its `Link` header, as an absolute URL inside the provider's API base.
 * Returns undefined on the last page and throws for a target outside the API base.
 */
export function nextPage(provider: ForgeProvider, link: string | null): string | undefined {
  const target = link?.split(",").map(part => /<([^>]+)>\s*;\s*rel="next"/.exec(part)?.[1]).find(Boolean)
  if (!target) return undefined
  const base = new URL(provider.baseUrl)
  const prefix = `${base.pathname.replace(/\/$/, "")}/`
  const next = new URL(target)
  if (next.origin !== base.origin || !`${next.pathname}`.startsWith(prefix)) {
    throw new Error("GitHub returned a pagination link outside the API base.")
  }
  return next.href
}
