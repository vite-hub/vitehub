import { ViteHubError, type ViteHubErrorShape } from "@vite-hub/runtime"

export class WorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "WorkspaceError"
  }
}

export class WorkspaceNotFoundError extends WorkspaceError {
  readonly code = "WORKSPACE_NOT_FOUND" as const
  readonly details: { name: string }
  readonly retryable: false = false
  readonly toJSON: () => ViteHubErrorShape<"WORKSPACE_NOT_FOUND", { name: string }> = ViteHubError.prototype.toJSON

  constructor(name: string) {
    super(`[vitehub] Workspace "${name}" is not registered.`)
    this.name = "WorkspaceNotFoundError"
    this.details = { name }
  }
}

export class WorkspacePathError extends WorkspaceError {
  readonly code = "WORKSPACE_PATH_INVALID" as const
  readonly details: { path: string }
  readonly retryable: false = false
  readonly toJSON: () => ViteHubErrorShape<"WORKSPACE_PATH_INVALID", { path: string }> = ViteHubError.prototype.toJSON

  constructor(path: string) {
    super(`[vitehub] Workspace path escapes the workspace root: ${JSON.stringify(path)}.`)
    this.name = "WorkspacePathError"
    this.details = { path }
  }
}
