import type { GitHubSourceOptions } from "./types.ts"
import type { SourceCacheOptions } from "../../core/types.ts"

export function normalizeGitHubCache(options: Pick<GitHubSourceOptions, "cache">): SourceCacheOptions | undefined {
  if (options.cache === false) return
  if (options.cache && typeof options.cache === "object") {
    return { maxAge: options.cache.maxAge }
  }
}

export function createGitHubCacheKey(input: {
  exclude?: string | string[]
  include?: string | string[]
  key?: string
  kind: string
  ref: string
  repo: string
  root: string
  token: string
}) {
  return [
    input.kind,
    input.repo,
    input.ref,
    input.root,
    normalizePatternCacheKey(input.include),
    normalizePatternCacheKey(input.exclude),
    input.token,
    input.key || "",
  ].join(":")
}

function normalizePatternCacheKey(value: string | string[] | undefined) {
  if (!value) return ""
  return Array.isArray(value) ? value.join(",") : value
}
