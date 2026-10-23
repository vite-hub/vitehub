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
