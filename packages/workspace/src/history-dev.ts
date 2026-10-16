import { isPlainObject } from "@vite-hub/internal/object"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

import type { WorkspaceRevision } from "./core/types.ts"

/** Vite Development Server route that `vitehub workspace history`, `refs`, and `show` call. */
export const workspaceHistoryDevRoute = "/__vitehub/workspace/history"
/** Nitro route that the dev endpoint forwards history reads to. The route exists only in `vite dev`. */
export const workspaceHistoryDevRuntimeRoute = "/_vitehub/workspace/history"
export const workspaceHistoryDevHeader = "x-vitehub-workspace-history"
export const workspaceHistoryDevHeaderValue = "1"
export const workspaceHistoryDevTokenNamespace = "workspace-history"
export const workspaceHistoryDevTokenServerHeader = "x-vitehub-workspace-history-server"

/** A retained revision as `vitehub workspace history`, `refs`, and `show` report it. */
export interface WorkspaceHistoryDevRevision extends WorkspaceRevision {
  /** The `author` string from the revision metadata, when it has one. */
  author?: string
}

export type WorkspaceHistoryDevRequest =
  | { operation: "history", workspace: string, cursor?: string, limit?: number, ref?: string }
  | { operation: "refs", workspace: string }
  | { operation: "show", workspace: string, path?: string, target: string }

export interface WorkspaceHistoryDevList {
  workspace: string
  /** Set when the list reads one ref. Without it, the list merges every ref, newest first. */
  ref?: string
  revisions: WorkspaceHistoryDevRevision[]
  /** Pass to the next request with the same ref. */
  cursor?: string
  /** True when older revisions exist than the ones in this list. */
  more: boolean
}

export interface WorkspaceHistoryDevRefs {
  workspace: string
  refs: Array<{ name: string, head: WorkspaceHistoryDevRevision }>
}

export interface WorkspaceHistoryDevFile {
  path: string
  size?: number
  mediaType?: string
  /** SHA-256 of the retained bytes, when the Store reports it. */
  digest?: string
}

export interface WorkspaceHistoryDevContent extends WorkspaceHistoryDevFile {
  /** `utf8` for valid UTF-8 text. Other bytes use `base64`. */
  encoding: "base64" | "utf8"
  content: string
}

export interface WorkspaceHistoryDevDetails {
  workspace: string
  revision: WorkspaceHistoryDevRevision
  /** The path inside the revision, when the request names one. */
  path?: string
  /** Files of the revision, or of the directory at `path`. */
  files?: WorkspaceHistoryDevFile[]
  /** The file at `path`. */
  file?: WorkspaceHistoryDevContent
}

export type WorkspaceHistoryDevResult = WorkspaceHistoryDevList | WorkspaceHistoryDevRefs | WorkspaceHistoryDevDetails

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || (hasRuntimeType(value, "string") && value.length > 0)
}

/** Reads one history request from an untrusted payload. Returns an error message when it is invalid. */
export function parseWorkspaceHistoryDevRequest(value: unknown): WorkspaceHistoryDevRequest | string {
  if (!isPlainObject(value) || !hasRuntimeType(value.workspace, "string") || !value.workspace) return "Missing Workspace name."
  const workspace = value.workspace
  if (value.operation === "refs") return { operation: "refs", workspace }
  if (value.operation === "history") {
    const { cursor, limit, ref } = value
    if (!optionalString(cursor) || !optionalString(ref)) return "Workspace history cursor and ref must be strings."
    if (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1)) return "Workspace history limit must be a positive integer."
    if (cursor !== undefined && ref === undefined) return "Workspace history cursor requires a ref."
    const result: Extract<WorkspaceHistoryDevRequest, { operation: "history" }> = {
      operation: "history",
      workspace,
    }
    if (cursor !== undefined) result.cursor = cursor
    if (limit !== undefined) result.limit = Number(limit)
    if (ref !== undefined) result.ref = ref
    return result
  }
  if (value.operation === "show") {
    const { path, target } = value
    if (!hasRuntimeType(target, "string") || !target) return "Workspace show requires a ref or revision."
    if (!optionalString(path)) return "Workspace show path must be a string."
    return path === undefined ? { operation: "show", workspace, target } : { operation: "show", workspace, target, path }
  }
  return "Unknown Workspace history operation."
}
