import { getViteHubErrorShape, ViteHubError } from "@vite-hub/runtime"
import type { ViteHubErrorDetails, ViteHubErrorOptions } from "@vite-hub/runtime"
import type { Diagnostic } from "nostics"

import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"

export type WorkspaceErrorCode = "WORKSPACE_CONFLICT" | "WORKSPACE_FAILED" | "WORKSPACE_NOT_FOUND" | "WORKSPACE_PATH_INVALID" | "WORKSPACE_SOURCE_READ_ONLY"

/** A Workspace `ViteHubError` that also has the `why`, `fix`, and `docs` of its catalog entry. */
export type WorkspaceDiagnosticError = ViteHubError & Pick<Diagnostic, "docs" | "fix" | "why">

/** Why a Workspace path is not valid: it uses a reserved name, or it is not a relative path inside the root. */
export type WorkspacePathProblem = "not-relative" | "reserved"

function diagnosticError(diagnostic: Diagnostic, options: ViteHubErrorOptions = {}, message = `[vitehub] ${diagnostic.why}`): WorkspaceDiagnosticError {
  const error = new ViteHubError(diagnostic.code, message, options)
  return Object.defineProperties(error, {
    docs: { configurable: true, enumerable: false, value: diagnostic.docs, writable: false },
    fix: { configurable: true, enumerable: false, value: diagnostic.fix, writable: false },
    why: { configurable: true, enumerable: false, value: diagnostic.why, writable: false },
  }) as WorkspaceDiagnosticError
}

export function workspaceError(message: string, options?: ErrorOptions): ViteHubError {
  const code = message.startsWith("[vitehub] Workspace file does not exist:")
    || message.startsWith("[vitehub] Workspace path does not exist:")
    || message.startsWith("[vitehub] Custom Workspace Source file does not exist:")
    ? "WORKSPACE_NOT_FOUND"
    : "WORKSPACE_FAILED"
  return new ViteHubError(code, message, options)
}

export function workspaceConflict(message: string, options?: ViteHubErrorOptions & { conditionalRemovalUnsupported?: boolean }): WorkspaceDiagnosticError {
  const diagnostic = workspaceErrorDiagnostics.WORKSPACE_CONFLICT({
    conditionalRemovalUnsupported: options?.conditionalRemovalUnsupported,
    message: message.replace(/^\[vitehub\] /, ""),
  })
  return diagnosticError(diagnostic, options, message)
}

export function workspaceConflictError(path: string, expected: string | null, actual: string | undefined): WorkspaceDiagnosticError {
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

export function workspacePathError(path: string, problem: WorkspacePathProblem = "not-relative"): WorkspaceDiagnosticError {
  const publicPath = path.slice(0, 4_096)
  return diagnosticError(workspaceErrorDiagnostics.WORKSPACE_PATH_INVALID({ path: JSON.stringify(publicPath), problem }), {
    details: { path: publicPath },
  })
}

/** Rejects a write, removal, or move into a path that a Source owns. `source` is the key of that Source, when it is known. */
export function workspaceSourceReadOnlyError(path: string, source?: string): WorkspaceDiagnosticError {
  const details: ViteHubErrorDetails = source === undefined ? { path } : { path, source }
  return diagnosticError(workspaceErrorDiagnostics.WORKSPACE_SOURCE_READ_ONLY({ path, source }), { details })
}

export function isWorkspaceError(value: unknown): boolean {
  const code = getViteHubErrorShape(value)?.code
  return code === "WORKSPACE_CONFLICT" || code === "WORKSPACE_FAILED" || code === "WORKSPACE_NOT_FOUND" || code === "WORKSPACE_PATH_INVALID" || code === "WORKSPACE_SOURCE_READ_ONLY"
}

export function isWorkspaceConflict(value: unknown): boolean {
  return getViteHubErrorShape(value)?.code === "WORKSPACE_CONFLICT"
}
