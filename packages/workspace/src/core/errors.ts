import { getViteHubErrorShape, ViteHubError } from "@vite-hub/runtime"
import type { ViteHubErrorOptions } from "@vite-hub/runtime"

export type WorkspaceErrorCode = "WORKSPACE_COLLECTION_CURSOR_INVALID" | "WORKSPACE_CONFLICT" | "WORKSPACE_FAILED" | "WORKSPACE_NOT_FOUND" | "WORKSPACE_PATH_INVALID"

export function workspaceError(message: string, options?: ErrorOptions): ViteHubError {
  return new ViteHubError("WORKSPACE_FAILED", message, options)
}

export function workspaceConflict(message: string, options?: ViteHubErrorOptions): ViteHubError {
  return new ViteHubError("WORKSPACE_CONFLICT", message, options)
}

export function workspaceConflictError(path: string, expected: string | null, actual: string | undefined): ViteHubError {
  return workspaceConflict(`[vitehub] Workspace path changed before the conditional write: ${path}.`, { details: { actual, expected, path } })
}

export function assertWorkspaceDigest(path: string, expected: string | null, actual: string | undefined): void {
  if (expected === null ? actual !== undefined : actual !== expected) throw workspaceConflictError(path, expected, actual)
}

export function workspaceNotFoundError(name: string): ViteHubError {
  return new ViteHubError("WORKSPACE_NOT_FOUND", `[vitehub] Workspace "${name}" is not registered.`, {
    details: { name },
  })
}

export function workspacePathError(path: string): ViteHubError {
  const publicPath = path.slice(0, 4_096)
  return new ViteHubError("WORKSPACE_PATH_INVALID", `[vitehub] Workspace path escapes the workspace root: ${JSON.stringify(publicPath)}.`, {
    details: { path: publicPath },
  })
}

export function isWorkspaceError(value: unknown): boolean {
  const code = getViteHubErrorShape(value)?.code
  return code === "WORKSPACE_COLLECTION_CURSOR_INVALID" || code === "WORKSPACE_CONFLICT" || code === "WORKSPACE_FAILED" || code === "WORKSPACE_NOT_FOUND" || code === "WORKSPACE_PATH_INVALID"
}

export function isWorkspaceConflict(value: unknown): boolean {
  return getViteHubErrorShape(value)?.code === "WORKSPACE_CONFLICT"
}
