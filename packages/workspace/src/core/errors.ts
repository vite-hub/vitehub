import { ViteHubError, type ViteHubErrorShape } from "@vite-hub/runtime"

export class WorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "WorkspaceError"
  }
}

export type WorkspaceNotFoundErrorDetails = {
  readonly name: string
}

export type WorkspacePathErrorReason = "absolute" | "empty" | "invalid" | "reserved" | "traversal"

export type WorkspacePathErrorDetails = {
  readonly reason: WorkspacePathErrorReason
}

function safeWorkspaceName(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(value) ? value : undefined
}

export function workspacePathErrorReason(value: unknown): WorkspacePathErrorReason | undefined {
  if (typeof value !== "string" || value.length > 4096) return "invalid"
  if (!value) return "empty"
  const raw = value.replace(/\\/g, "/")
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return "absolute"
  const parts = raw.split("/").filter(Boolean)
  if (parts.some(part => part === "." || part === "..")) return "traversal"
  if (parts[0] === ".git" || parts[0] === ".vitehub") return "reserved"
}

export class WorkspaceNotFoundError extends WorkspaceError {
  readonly code = "WORKSPACE_NOT_FOUND" as const
  readonly details?: WorkspaceNotFoundErrorDetails
  readonly retryable: false = false
  readonly toJSON: () => ViteHubErrorShape<"WORKSPACE_NOT_FOUND", WorkspaceNotFoundErrorDetails> = ViteHubError.prototype.toJSON

  constructor(name: string) {
    super("[vitehub] Workspace is not registered.")
    this.name = "WorkspaceNotFoundError"
    const safeName = safeWorkspaceName(name)
    if (safeName !== undefined) this.details = { name: safeName }
  }
}

export class WorkspacePathError extends WorkspaceError {
  readonly code = "WORKSPACE_PATH_INVALID" as const
  readonly details: WorkspacePathErrorDetails
  readonly retryable: false = false
  readonly toJSON: () => ViteHubErrorShape<"WORKSPACE_PATH_INVALID", WorkspacePathErrorDetails> = ViteHubError.prototype.toJSON

  constructor(path: string) {
    super("[vitehub] Workspace path is invalid.")
    this.name = "WorkspacePathError"
    this.details = { reason: workspacePathErrorReason(path) ?? "invalid" }
  }
}
