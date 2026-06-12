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
  const preflight = await preflightWorkspaceInspectionCommand(command, options.fs, options.broadSearchPaths, options.cwd)
  if (preflight) return preflight
  const missingPath = await preflightMissingWorkspacePath(command, options.fs, options.cwd)
  if (missingPath) return missingPath
  const unsupported = preflightUnsupportedWorkspaceCommand(command, options.commands)
  if (unsupported) return unsupported
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
  const result = await runtime.exec(command, { cwd: options.cwd || workspaceMountPoint, timeout })
  const noMatchFeedback = searchNoMatchFeedback(command, result, options.broadSearchPaths, options.cwd)

  return noMatchFeedback ? { ...result, stdout: noMatchFeedback, workspaceGuardrail: { kind: "no_match" } } : result
}

async function preflightWorkspaceInspectionCommand(command: string, fs: WorkspaceShellFileSystem, broadSearchPaths: string[] = [], cwd = workspaceMountPoint): Promise<ShellObservation | undefined> {
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
        if (!isWorkspacePathCandidate(path)) continue
        const resolvedPath = resolveWorkspaceShellPath(currentCwd, path)
        const directory = await workspacePathIsDirectory(fs, resolvedPath)
        if (segment.separatorAfter === "&&" && !directory) skipAndChain = true
        if (segment.separatorAfter === "||" && directory) skipOrChain = true
        if (directory) {
          currentCwd = resolvedPath ? posix.join(workspaceMountPoint, resolvedPath) : workspaceMountPoint
        }
        continue
      }
      if (isBroadWorkspaceSearch(segment, broadSearchPaths, currentCwd)) return broadWorkspaceSearchFeedback(broadSearchPaths)
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
        if (!isWorkspacePathCandidate(path)) continue
        const resolvedPath = resolveWorkspaceShellPath(currentCwd, path)
        const directory = await workspacePathIsDirectory(fs, resolvedPath)
        if (segment.separatorAfter === "&&" && !directory) skipAndChain = true
        if (segment.separatorAfter === "||" && directory) skipOrChain = true
        if (directory) {
          currentCwd = resolvedPath ? posix.join(workspaceMountPoint, resolvedPath) : workspaceMountPoint
        }
        continue
      }
      for (const path of segment.paths) {
        if (!isConcreteWorkspacePath(path)) continue
        const resolvedPath = resolveWorkspaceShellPath(currentCwd, path)
        if (await fs.exists(resolvedPath)) continue
        if (segment.separatorAfter === "||") continue
        return missingWorkspacePathFeedback(command, resolvedPath)
      }
      if (segment.separatorAfter === "&&" || segment.separatorAfter === "||") return undefined
    }
  }
  catch {
    return undefined
  }
}

async function workspacePathIsDirectory(fs: WorkspaceShellFileSystem, path: string) {
  if (path === "") return true
  try {
    return (await fs.stat(path)).isDirectory
  }
  catch {
    return false
  }
}

function missingWorkspacePathFeedback(command: string, resolvedPath: string): ShellObservation {
  return {
    command,
    event: "command_finished",
    exitCode: 0,
    stderr: "",
    stdout: [
      `[vitehub] Workspace path is not mounted: ${resolvedPath}`,
      "The agent cannot inspect files outside the configured workspace sources.",
      "If this path should exist, update the Agent workspace source configuration or materialize the correct mounted source.",
      "Otherwise answer that the requested evidence is unavailable in the current workspace.",
    ].join("\n") + "\n",
    workspaceGuardrail: { kind: "missing_path", path: resolvedPath },
  }
}

function isBroadWorkspaceSearch(segment: ReturnType<typeof analyzeWorkspaceInspectionCommand>[number], broadSearchPaths: string[] = [], cwd = workspaceMountPoint) {
  const name = segment.words[0]
  if (name === "rg" || name === "grep") {
    const paths = segment.paths
    const pipeSafeStdinFilter = name === "grep" && segment.followsPipe && !segment.searchRecursive
    return (paths.length === 0 && !pipeSafeStdinFilter)
      || paths.length > 4
      || paths.some(path => isBroadWorkspacePath(path, broadSearchPaths, cwd))
  }
  if (name === "find") {
    const paths = segment.paths
    return (paths.length === 0 && isBroadWorkspacePath(".", broadSearchPaths, cwd))
      || paths.some(path => isBroadWorkspacePath(path, broadSearchPaths, cwd))
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
    workspaceGuardrail: { kind: "broad_search" },
  }
}

function isBroadWorkspacePath(path: string, broadSearchPaths: string[] = [], cwd = workspaceMountPoint) {
  const normalized = cleanWorkspaceShellPath(resolvedWorkspaceCwd(cwd, path)) || "."
  return normalized === "." || broadSearchPaths.includes(normalized)
}

function searchNoMatchFeedback(command: string, result: ShellObservation, broadSearchPaths: string[] = [], cwd = workspaceMountPoint) {
  if (result.exitCode !== 1 || result.stderr || result.stdout) return ""
  try {
    let currentCwd = cwd
    for (const segment of analyzeWorkspaceInspectionCommand(command)) {
      const words = segment.words
      if (words[0] === "cd") {
        const path = words[1] || workspaceMountPoint
        if (isWorkspacePathCandidate(path)) currentCwd = resolvedWorkspaceCwd(currentCwd, path)
        continue
      }
      if (words[0] !== "rg" && words[0] !== "grep") {
        if (segment.separatorAfter === "&&") return ""
        continue
      }
      const paths = segment.paths
      const hasBroadPath = paths.some(path => isBroadWorkspacePath(path, broadSearchPaths, currentCwd))
      if (!hasBroadPath) {
        if (segment.separatorAfter === "&&") return ""
        continue
      }
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

function preflightUnsupportedWorkspaceCommand(command: string, commands: string[] = []): ShellObservation | undefined {
  const allowed = new Set([...commands, "cd", "false", "true"])
  for (const segment of analyzeWorkspaceInspectionCommand(command)) {
    const executable = workspaceExecutable(segment.words)
    if (!executable || allowed.has(executable.name)) continue
    return unsupportedWorkspaceCommandFeedback(command, executable.name, commands)
  }
}

function unsupportedWorkspaceCommandFeedback(command: string, name: string, commands: string[]): ShellObservation {
  const available = [...new Set(commands)].sort()
  const formatted = available.length ? available.map(command => `\`${command}\``).join(", ") : "none"
  return {
    command,
    event: "policy_denied",
    exitCode: 126,
    stderr: `[vitehub] Unsupported workspace shell command: ${name}. Available commands: ${available.join(", ") || "none"}.\n`,
    stdout: [
      `[vitehub] Workspace shell command is not available: ${name}`,
      `Use only the available workspace commands: ${formatted}.`,
      "Rewrite the command with supported workspace commands, or answer from the evidence already collected.",
    ].join("\n") + "\n",
  }
}

function workspaceExecutable(words: string[]) {
  for (const [index, word] of words.entries()) {
    if (isAssignmentWord(word)) continue
    return { index, name: word }
  }
}

function isAssignmentWord(word: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word)
}

function isConcreteWorkspacePath(path: string) {
  return isWorkspacePathCandidate(path) && cleanWorkspaceShellPath(path) !== ""
}

function isWorkspacePathCandidate(path: string) {
  return Boolean(path)
    && path !== "-"
    && !path.includes("$")
    && !path.includes("`")
    && !path.includes("*")
    && !path.includes("?")
    && !path.includes("[")
}

function resolveWorkspaceShellPath(cwd: string, path: string) {
  return cleanWorkspaceShellPath(resolvedWorkspaceCwd(cwd, path))
}

function resolvedWorkspaceCwd(cwd: string, path: string) {
  if (path.startsWith("/") && !path.startsWith(workspaceMountPoint)) {
    return path
  }
  if (path.startsWith(workspaceMountPoint)) return path
  const normalizedCwd = cleanWorkspaceShellPath(cwd)
  const resolvedPath = normalizedCwd ? posix.join(normalizedCwd, path) : path
  return posix.join(workspaceMountPoint, resolvedPath)
}
