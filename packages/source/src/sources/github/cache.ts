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
  return JSON.stringify([
    input.kind,
    input.repo,
    input.ref,
    input.root,
    input.include ?? null,
    input.ignore ?? null,
    input.authScope,
    input.key || "",
  ])
}

export function githubAuthenticationScope(token: string | undefined) {
  return token ? createHash("sha256").update(token).digest("hex") : "anonymous"
}
