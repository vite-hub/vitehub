import type { WorkspaceRevision } from "./core/types.ts"
import type { WorkspaceStaleFile } from "./lineage.ts"

/** Revisions that one `workspace.history` call returns when the caller names no limit. */
export const workspaceHistoryDefaultLimit = 20
/** The most revisions that one `workspace.history` call may return. */
export const workspaceHistoryMaximumLimit = 100
/**
 * The largest `workspace.commit` request body: 4 MiB of JSON, with base64 for binary files. Vercel Functions accept
 * request bodies up to 4.5 MB and Cloudflare Workers up to 100 MB, so one push works on every host.
 */
export const workspaceCommitRequestBytes = 4 * 1_024 * 1_024

/** A retained revision as `workspace.history`, `workspace.refs`, and `workspace.show` report it. */
export interface WorkspaceHistoryRevision extends WorkspaceRevision {
  /** The `author` string from the revision metadata, when it has one. */
  author?: string
}

export interface WorkspaceHistoryList {
  workspace: string
  /** Set when the list reads one ref. Without it, the list merges every ref, newest first. */
  ref?: string
  revisions: WorkspaceHistoryRevision[]
  /** Pass to the next request with the same ref. */
  cursor?: string
  /** True when older revisions exist than the ones in this list. */
  more: boolean
}

export interface WorkspaceHistoryRefs {
  workspace: string
  refs: Array<{ name: string, head: WorkspaceHistoryRevision }>
}

export interface WorkspaceHistoryFile {
  path: string
  size?: number
  mediaType?: string
  /** SHA-256 of the retained bytes, when the Store reports it. */
  digest?: string
}

export interface WorkspaceHistoryContent extends WorkspaceHistoryFile {
  /** `utf8` for valid UTF-8 text. Other bytes use `base64`. */
  encoding: "base64" | "utf8"
  content: string
}

export interface WorkspaceHistoryDetails {
  workspace: string
  revision: WorkspaceHistoryRevision
  /** The path inside the revision, when the request names one. */
  path?: string
  /** Files of the revision, or of the directory at `path`. */
  files?: WorkspaceHistoryFile[]
  /** The file at `path`. */
  file?: WorkspaceHistoryContent
}

/** A file that differs between two revisions of a ref, as `workspace.changes` reports it. */
export interface WorkspaceChangedFile {
  path: string
  /** True when the head no longer has the file. */
  deleted?: true
  /** The file at the head. Missing when it was deleted, or when the call asked for no content. */
  head?: Pick<WorkspaceHistoryContent, "content" | "encoding">
  /** The file at the base revision, for a three-way merge. Missing when the file is new. */
  base?: Pick<WorkspaceHistoryContent, "content" | "encoding">
}

export interface WorkspaceChanges {
  workspace: string
  ref: string
  /** The head of the ref, or null when the ref has no revision yet. */
  head: WorkspaceHistoryRevision | null
  /** Files that changed since the base revision, sorted by path. Every file of the head without a base. */
  files: WorkspaceChangedFile[]
}

export interface WorkspaceStaleList {
  workspace: string
  ref: string
  /** The head that the list reads, or null when the ref has no revision yet. */
  head: string | null
  stale: WorkspaceStaleFile[]
}

export interface WorkspaceCommitResult {
  workspace: string
  revision: WorkspaceHistoryRevision
}
