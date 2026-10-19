import type { SourceCacheOptions } from "../../core/types.ts"

export interface GitHubSourceOptions {
  repo: string
  ref?: string
  root?: string
  /**
   * GitHub token, or a trusted callback that returns one. Omitted: Server Env `VITEHUB_GITHUB_TOKEN`, then `FORGES_GITHUB_TOKEN`.
   * `false`: anonymous reads only.
   */
  auth?: false | string | (() => Promise<string | undefined> | string | undefined)
  include?: string | string[]
  ignore?: string | readonly string[]
  cache?: false | SourceCacheOptions
}

export interface GitHubFile<TKey extends string = string> {
  content?: Uint8Array
  key: TKey
  path: string
  ref: string
  sha: string | undefined
}

export interface GitHubArchiveFile {
  content: Uint8Array
  path: string
}
