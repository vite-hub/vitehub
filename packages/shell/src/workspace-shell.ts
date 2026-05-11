import { posix } from "node:path"

import { createJustBashRuntime } from "./runtime.ts"
import { workspaceMountPoint } from "./workspace-fs.ts"

import type {
  SearchableShellWorkspace,
  ShellRuntimeExecResult,
  WorkspaceShellFileSystem,
} from "./types.ts"

interface WorkspaceInspectionCommandOptions {
  commands?: string[]
  cwd?: string
  fs: WorkspaceShellFileSystem
  maxOutputLength?: number
  provider?: "cloudflare-shell" | "just-bash"
}

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

export async function runWorkspaceInspectionCommand(
  _input: SearchableShellWorkspace,
  command: string,
  options: WorkspaceInspectionCommandOptions,
): Promise<ShellRuntimeExecResult> {
  const maxOutputLength = options.maxOutputLength || 30_000
  const runtime = createJustBashRuntime({
    commands: options.commands,
    cwd: options.cwd || workspaceMountPoint,
    fs: options.fs,
  })
  const result = await runtime.exec(command, { cwd: options.cwd || workspaceMountPoint })

  return {
    exitCode: result.exitCode,
    stderr: applyOutputLimit(result.stderr, maxOutputLength),
    stdout: applyOutputLimit(result.stdout, maxOutputLength),
  }
}

function normalizeSafeShellPath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/")).replace(/^\//, "")
  if (normalized === ".") return ""
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`[vitehub] Workspace path escapes the workspace root: "${path}".`)
  }
  return normalized
}

function applyOutputLimit(output: string, maxLength: number): string {
  if (output.length <= maxLength) return output
  return `${output.slice(0, maxLength)}\n[output truncated to ${maxLength} characters]\n`
}
