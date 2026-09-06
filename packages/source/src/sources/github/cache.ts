import { createHash } from "node:crypto"

import type { GitHubSourceOptions } from "./types.ts"
import type { SourceCacheOptions } from "../../core/types.ts"

export function normalizeGitHubCache(options: Pick<GitHubSourceOptions, "cache">): SourceCacheOptions | undefined {
  if (options.cache === false) return
  if (options.cache && typeof options.cache === "object") {
    return { maxAge: options.cache.maxAge }
  }
}

export function createGitHubCacheKey(input: {
  authScope: string
  ignore?: string | readonly string[]
  include?: string | string[]
  key?: string
  kind: string
  ref: string
  repo: string
  root: string
}) {
  return [
    input.kind,
    input.repo,
    input.ref,
    input.root,
    normalizePatternCacheKey(input.include),
    normalizePatternCacheKey(input.ignore),
    input.authScope,
    input.key || "",
  ].join(":")
}

export function githubAuthenticationScope(token: string | undefined) {
  return token ? createHash("sha256").update(token).digest("hex") : "anonymous"
}

function normalizePatternCacheKey(value: string | readonly string[] | undefined) {
  if (!value) return ""
  return Array.isArray(value) ? value.join(",") : String(value)
}
