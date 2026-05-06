import type { GitHubSourceOptions } from "./types.ts"
import type { SourceCacheOptions } from "../../core/types.ts"

export function normalizeGitHubCache(options: Pick<GitHubSourceOptions, "cache" | "swr">): SourceCacheOptions {
  if (options.cache === false) return { maxAge: 0, swr: false }
  if (options.cache && typeof options.cache === "object") {
    return {
      maxAge: options.cache.maxAge ?? 1,
      staleMaxAge: options.cache.staleMaxAge,
      swr: options.cache.swr ?? true,
    }
  }
  if (typeof options.swr === "number") return { maxAge: options.swr, swr: true }
  return { maxAge: 1, swr: options.swr === false ? false : true }
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
