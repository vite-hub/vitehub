import type { WorkspaceRevision } from "./core/types.ts"

/** Revisions that one `workspace.history` call returns when the caller names no limit. */
export const workspaceHistoryDefaultLimit = 20
/** The most revisions that one `workspace.history` call may return. */
export const workspaceHistoryMaximumLimit = 100

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
