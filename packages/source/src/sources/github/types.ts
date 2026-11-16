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

/** A ref of the repository: a full commit SHA, a branch name, or a pull request number. */
export type GitHubRef = { sha: string } | { branch: string } | { pull: number }

/** A pull request, as `resolveRef({ pull })` returns it. */
export interface GitHubPullRequest {
  number: number
  state: "open" | "closed"
  merged: boolean
  /** The head branch, such as `feat/x`. */
  head: string
  /** The repository of the head branch, such as `acme/docs`. Null when the fork was deleted. */
  headRepo: string | null
  /** The base branch, such as `main`. */
  base: string
  /** True when the head branch lives in another repository. */
  fork: boolean
  /** The label names, such as `preview:enabled`. */
  labels: string[]
}

/** The commit that a ref points to. `pull` is set for a pull request ref. */
export interface GitHubRefTarget {
  sha: string
  pull?: GitHubPullRequest
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
  /**
   * The latest commit that changed each file, from the full commit SHA `sha` back. A key without commits has no entry.
   * It asks GitHub GraphQL for 150 files per request, so 2,600 files cost 18 requests. Like `history()`, it does not
   * follow renames.
   */
  latest(keys: readonly string[], options: { sha: string }): Promise<Map<string, GitHubFileCommit>>
  /**
   * The keys of the Source that a commit from `base` to `head` changed, with the old key of a renamed file. A file that
   * one commit edits and a later one reverts is in the list. One compare request, plus one commit request per commit
   * when there is more than one. Undefined when `head` does not descend from `base`, when more than 20 commits lie
   * between them, or when more files changed than GitHub lists.
   */
  changes(base: string, head: string): Promise<string[] | undefined>
  /**
   * The keys of the Source that a pull request adds or changes, from `GET /repos/{owner}/{repo}/pulls/{number}/files`.
   * A renamed file gives its new key, and removed files are not listed. Undefined when the repository has no such pull
   * request. GitHub lists at most 3,000 files of a pull request.
   */
  pullChanges(number: number): Promise<string[] | undefined>
  /**
   * The commit that a ref of the repository points to now. A branch must match its full name, and a SHA must be a full
   * commit SHA. Undefined when the repository has no such commit, branch, or pull request.
   */
  resolveRef(ref: GitHubRef, options?: { signal?: AbortSignal }): Promise<GitHubRefTarget | undefined>
  /**
   * Whether the history of the Source ref (the `ref` option, or the default branch) contains a commit: GitHub compares
   * the ref with the commit and answers `behind` or `identical`. False for a commit that shares no history with it.
   */
  contains(sha: string, options?: { signal?: AbortSignal }): Promise<boolean>
  /**
   * The pull requests whose head commit is this commit, open or closed, from this repository or a fork. GitHub does not
   * list a fork pull request for its commits, so a fork pull request counts only while it is one of the 100 most recently
   * updated open pull requests.
   */
  pullsAt(sha: string, options?: { signal?: AbortSignal }): Promise<GitHubPullRequest[]>
}
