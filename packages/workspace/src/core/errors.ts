import { getViteHubErrorShape, ViteHubError } from "@vite-hub/runtime"

export type WorkspaceErrorCode = "WORKSPACE_COLLECTION_CURSOR_INVALID" | "WORKSPACE_FAILED" | "WORKSPACE_NOT_FOUND" | "WORKSPACE_PATH_INVALID"

export function workspaceError(message: string, options?: ErrorOptions): ViteHubError {
  return new ViteHubError("WORKSPACE_FAILED", message, options)
}

export function workspaceNotFoundError(name: string): ViteHubError {
  return new ViteHubError("WORKSPACE_NOT_FOUND", `[vitehub] Workspace "${name}" is not registered.`, {
    details: { name },
  })
}

export function workspacePathError(path: string): ViteHubError {
  return new ViteHubError("WORKSPACE_PATH_INVALID", `[vitehub] Workspace path escapes the workspace root: ${JSON.stringify(path)}.`, {
    details: { path },
  })
}

export function isWorkspaceError(value: unknown): boolean {
  const code = getViteHubErrorShape(value)?.code
  return code === "WORKSPACE_COLLECTION_CURSOR_INVALID" || code === "WORKSPACE_FAILED" || code === "WORKSPACE_NOT_FOUND" || code === "WORKSPACE_PATH_INVALID"
}
