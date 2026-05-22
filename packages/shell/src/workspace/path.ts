import { posix } from "node:path"

import { workspaceMountPoint } from "./filesystem.ts"

export function cleanWorkspaceShellPath(path = "."): string {
  const trimmed = path.trim() || "."
  if (trimmed === "." || trimmed === "./" || trimmed === "/" || trimmed === workspaceMountPoint) return ""
  return normalizeSafeShellPath(trimmed.replace(/^\/workspace(\/|$)/, ""))
}

export function cleanWorkspaceMutationPath(path: string): string {
  const normalized = cleanWorkspaceShellPath(path)
  if (!normalized) throw new Error("[vitehub] Workspace root is not a valid mutation target.")
  return normalized
}

function normalizeSafeShellPath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/")).replace(/^\//, "")
  if (normalized === ".") return ""
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`[vitehub] Workspace path escapes the workspace root: "${path}".`)
  }
  return normalized
}
