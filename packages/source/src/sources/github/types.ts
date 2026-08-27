import type { SourceCacheOptions } from "../../core/types.ts"

export interface GitHubSourceOptions {
  repo: string
  ref?: string
  root?: string
  auth?: false | string | (() => string | undefined)
  include?: string | string[]
  ignore?: string | string[]
  cache?: false | SourceCacheOptions
}

export interface GitHubRepositoryResponse {
  default_branch: string
}

export interface GitHubCommitResponse {
  sha: string
}

export interface GitHubFile<TKey extends string = string> {
  content?: Uint8Array
  key: TKey
  path: string
  ref: string
  sha: string | undefined
}

export interface GitHubContentResponse {
  content?: string
  encoding?: string
  path?: string
  sha?: string
  type?: "dir" | "file" | string
}

export interface GitHubArchiveFile {
  content: Uint8Array
  path: string
}
