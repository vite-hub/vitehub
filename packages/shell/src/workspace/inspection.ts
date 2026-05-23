import { posix } from "node:path"

import { createJustBashProvider } from "../providers/just-bash.ts"
import { createShellRuntime } from "../runtime/index.ts"
import { analyzeWorkspaceInspectionCommand } from "./command-analysis.ts"
import { workspaceMountPoint } from "./filesystem.ts"
import { cleanWorkspaceShellPath } from "./path.ts"

import type { ShellObservation } from "../runtime/types.ts"
import type { WorkspaceShellFileSystem } from "./filesystem.ts"
import type { SearchableShellWorkspace } from "./types.ts"

interface WorkspaceInspectionCommandOptions {
  broadSearchPaths?: string[]
  commands?: string[]
  cwd?: string
  fs: WorkspaceShellFileSystem
  maxOutputLength?: number
  timeout?: number
}

export async function runWorkspaceInspectionCommand(
  _input: SearchableShellWorkspace,
  command: string,
  options: WorkspaceInspectionCommandOptions,
): Promise<ShellObservation> {
  const maxOutputLength = options.maxOutputLength || 30_000
  const timeout = options.timeout || 30_000
  const preflight = preflightWorkspaceInspectionCommand(command, options.broadSearchPaths)
  if (preflight) return preflight
  const missingPath = await preflightMissingWorkspacePath(command, options.fs, options.cwd)
  if (missingPath) return missingPath
  const runtime = createShellRuntime({
    policy: {
      maxOutputLength,
      timeout,
    },
    provider: createJustBashProvider({
      commands: options.commands,
      cwd: options.cwd || workspaceMountPoint,
      fs: options.fs,
    }),
  })
  const result = await Promise.race([
    runtime.exec(command, { cwd: options.cwd || workspaceMountPoint, timeout }),
    new Promise<ShellObservation>(resolve => setTimeout(() => resolve({
      command,
      cwd: options.cwd || workspaceMountPoint,
      event: "command_timed_out",
      exitCode: null,
      stderr: `[vitehub] Workspace shell command timed out after ${timeout}ms.`,
      stdout: "",
      timedOut: true,
    }), timeout)),
  ])
  const noMatchFeedback = searchNoMatchFeedback(command, result, options.broadSearchPaths)

  return noMatchFeedback ? { ...result, stdout: noMatchFeedback } : result
}

function preflightWorkspaceInspectionCommand(command: string, broadSearchPaths: string[] = []): ShellObservation | undefined {
  try {
    for (const segment of analyzeWorkspaceInspectionCommand(command)) {
      if (isBroadWorkspaceSearch(segment, broadSearchPaths)) return broadWorkspaceSearchFeedback(broadSearchPaths)
    }
  }
  catch {
    return undefined
  }
}

async function preflightMissingWorkspacePath(command: string, fs: WorkspaceShellFileSystem, cwd = workspaceMountPoint): Promise<ShellObservation | undefined> {
  try {
    let currentCwd = cwd
    let skipAndChain = false
    let skipOrChain = false
    for (const segment of analyzeWorkspaceInspectionCommand(command)) {
      if (skipAndChain) {
        skipAndChain = segment.separatorAfter === "&&"
        continue
      }
      if (skipOrChain) {
        skipOrChain = segment.separatorAfter === "||"
        continue
      }
      const words = segment.words
      if (words[0] === "cd") {
        const path = words[1] || workspaceMountPoint
        if (!isConcreteWorkspacePath(path)) continue
        const resolvedPath = resolveWorkspaceShellPath(currentCwd, path)
        const exists = await fs.exists(resolvedPath)
        if (segment.separatorAfter === "&&" && !exists) skipAndChain = true
        if (segment.separatorAfter === "||" && exists) skipOrChain = true
        if (exists) {
          currentCwd = resolvedPath ? posix.join(workspaceMountPoint, resolvedPath) : workspaceMountPoint
        }
        continue
      }
      if (segment.separatorAfter === "&&" || segment.separatorAfter === "||") return undefined
      for (const path of segment.paths) {
        if (!isConcreteWorkspacePath(path)) continue
        const resolvedPath = resolveWorkspaceShellPath(currentCwd, path)
        if (await fs.exists(resolvedPath)) continue
        return missingWorkspacePathFeedback(resolvedPath)
      }
    }
  }
  catch {
    return undefined
  }
}

function missingWorkspacePathFeedback(resolvedPath: string): ShellObservation {
  return {
    command: "",
    event: "command_finished",
    exitCode: 0,
    stderr: "",
    stdout: [
      `[vitehub] Workspace path is not mounted: ${resolvedPath}`,
      "The agent cannot inspect files outside the configured workspace sources.",
      "If this path should exist, update the Agent workspace source configuration or materialize the correct mounted source.",
      "Otherwise answer that the requested evidence is unavailable in the current workspace.",
    ].join("\n") + "\n",
  }
}

function isBroadWorkspaceSearch(segment: ReturnType<typeof analyzeWorkspaceInspectionCommand>[number], broadSearchPaths: string[] = []) {
  const name = segment.words[0]
  if (name === "rg" || name === "grep") {
    const paths = segment.paths
    const pipeSafeStdinFilter = name === "grep" && segment.followsPipe && !segment.searchRecursive
    return (paths.length === 0 && !pipeSafeStdinFilter)
      || paths.length > 4
      || paths.some(path => isBroadWorkspacePath(path, broadSearchPaths))
  }
  if (name === "find") {
    const paths = segment.paths
    return paths.length === 0 || paths.some(path => isBroadWorkspacePath(path, broadSearchPaths))
  }
  return false
}

function broadWorkspaceSearchFeedback(broadSearchPaths: string[] = []): ShellObservation {
  const hint = broadSearchPaths.length
    ? ` Try one of these paths: ${broadSearchPaths.map(path => `"${path}"`).join(", ")}.`
    : " Use a narrow mounted source or subdirectory path instead."
  const feedback = [
    "[vitehub] Workspace search is too broad for this agent tool.",
    "Use one specific mounted subdirectory or file path.",
    "If the requested evidence is not in the mounted workspace paths, answer that it is unavailable instead of trying broader searches.",
  ].join("\n") + "\n"

  return {
    command: "",
    event: "policy_denied",
    exitCode: 126,
    stderr: `[vitehub] Workspace root search is too broad.${hint}\n`,
    stdout: feedback,
  }
}

function isBroadWorkspacePath(path: string, broadSearchPaths: string[] = []) {
  const normalized = cleanWorkspaceShellPath(path) || "."
  return normalized === "." || broadSearchPaths.includes(normalized)
}

function searchNoMatchFeedback(command: string, result: ShellObservation, broadSearchPaths: string[] = []) {
  if (result.exitCode !== 1 || result.stderr || result.stdout) return ""
  try {
    for (const segment of analyzeWorkspaceInspectionCommand(command)) {
      const words = segment.words
      if (words[0] !== "rg" && words[0] !== "grep") continue
      const paths = segment.paths
      if (!paths.some(path => isBroadWorkspacePath(path, broadSearchPaths))) continue
      return [
        "[vitehub] Search returned no matches in the mounted workspace source.",
        "If the expected file is outside this mounted source, tell the user the evidence is unavailable in the current workspace instead of continuing broad searches.",
        "Use a more specific mounted subdirectory only if the user request can be answered from the listed workspace paths.",
      ].join("\n") + "\n"
    }
  }
  catch {
    return ""
  }
  return ""
}

function isConcreteWorkspacePath(path: string) {
  return Boolean(path)
    && path !== "-"
    && cleanWorkspaceShellPath(path) !== ""
    && !path.includes("$")
    && !path.includes("`")
    && !path.includes("*")
    && !path.includes("?")
    && !path.includes("[")
}

function resolveWorkspaceShellPath(cwd: string, path: string) {
  if (path.startsWith("/") && !path.startsWith(workspaceMountPoint)) {
    return cleanWorkspaceShellPath(path)
  }
  if (path.startsWith(workspaceMountPoint)) return cleanWorkspaceShellPath(path)
  const normalizedCwd = cleanWorkspaceShellPath(cwd)
  return cleanWorkspaceShellPath(normalizedCwd ? posix.join(normalizedCwd, path) : path)
}
