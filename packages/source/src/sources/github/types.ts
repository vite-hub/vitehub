import type { FileSource, SourceCacheOptions } from "../../core/types.ts"

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

/** One commit that changed a file, as `GitHubSource.history()` returns it. */
export interface GitHubFileCommit {
  sha: string
  /** The author date, as an ISO date. */
  date: string
  /** The author's GitHub login, else the Git author name, else null. */
  author: string | null
  /** The first line of the commit message. */
  message: string
  /** The commit page on GitHub. */
  url: string
}

export interface GitHubHistoryOptions {
  /** The full commit SHA to read back from. */
  sha: string
  /** The page, from 1. */
  page: number
  /** Commits per page, from 1 to 100. */
  perPage: number
}

/** What github() returns: a File Source with every optional method. */
export type GitHubSource = FileSource<string> & Required<Pick<FileSource<string>, "getItems" | "getMeta" | "resolveRevision">> & {
  /** Whether reads send a token: `auth`, or the Server Env token when `auth` is omitted. */
  authenticated(): Promise<boolean>
  /**
   * The commits that changed one file, newest first, from `sha` back. It reads `GET /repos/{owner}/{repo}/commits`
   * with `path`, so it does not follow renames. `more` is true when GitHub has another page.
   */
  history(key: string, options: GitHubHistoryOptions): Promise<{ commits: GitHubFileCommit[], more: boolean }>
}
