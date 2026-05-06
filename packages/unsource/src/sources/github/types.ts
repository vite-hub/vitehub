import type { SourceCacheOptions } from "../../core/types.ts"

export interface GitHubSourceOptions {
  repo: string
  ref?: string
  root?: string
  auth?: string | (() => string | undefined)
  include?: string | string[]
  exclude?: string | string[]
  cache?: false | SourceCacheOptions
  swr?: boolean | number
}

export interface GitHubTreeItem {
  path: string
  sha?: string
  type: "blob" | "tree"
}

export interface GitHubTreeResponse {
  sha: string
  tree: GitHubTreeItem[]
  truncated?: boolean
}

export interface GitHubContentResponse {
  content?: string
  encoding?: string
}

export interface GitHubFile<TKey extends string = string> {
  content?: Uint8Array
  key: TKey
  path: string
  sha: string | undefined
}

export interface GitHubArchiveFile {
  content: Uint8Array
  path: string
}
