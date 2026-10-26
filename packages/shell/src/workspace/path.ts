import { posix } from "node:path"

import { workspaceMountPoint } from "./filesystem.ts"
import { shellErrorDiagnostics } from "../error-diagnostics.ts"

export function cleanWorkspaceShellPath(path = "."): string {
  const input = path || "."
  if (input === "." || input === "./" || input === "/" || input === workspaceMountPoint) return ""
  return normalizeSafeShellPath(input.replace(/^\/workspace(\/|$)/, ""))
}

export function cleanWorkspaceMutationPath(path: string): string {
  const normalized = cleanWorkspaceShellPath(path)
  if (!normalized) throw shellErrorDiagnostics.SHELL_R0020({ message: "[vitehub] Workspace root is not a valid mutation target." })
  return normalized
}

function normalizeSafeShellPath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/")).replace(/^\//, "")
  if (normalized === ".") return ""
  if (normalized === ".." || normalized.startsWith("../")) {
    throw shellErrorDiagnostics.SHELL_R0021({ message: `[vitehub] Workspace path escapes the workspace root: "${path}".` })
  }
  return normalized
}
