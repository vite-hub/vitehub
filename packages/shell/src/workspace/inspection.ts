import { posix } from "node:path"

import { createJustBashProvider } from "../providers/just-bash.ts"
import { createShellRuntime } from "../runtime/index.ts"
import { analyzeWorkspaceInspectionCommand } from "./command-analysis.ts"
import { workspaceMountPoint } from "./filesystem.ts"
import { cleanWorkspaceShellPath } from "./path.ts"

import type { ShellObservation } from "../runtime/types.ts"
import type { WorkspaceShellFileSystem } from "./filesystem.ts"
import type { SearchableShellWorkspace, ShellEntry, ShellStat } from "./types.ts"

interface WorkspaceInspectionCommandOptions {
  broadSearchPaths?: string[]
  commands?: string[]
  cwd?: string
  fs: WorkspaceShellFileSystem
  maxOutputLength?: number
  timeout?: number
}

export async function runWorkspaceInspectionCommand(
  input: SearchableShellWorkspace,
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
  const direct = await runDirectWorkspaceInspectionCommand(input, command, {
    cwd: options.cwd || workspaceMountPoint,
    maxOutputLength,
  })
  if (direct) return direct
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

async function runDirectWorkspaceInspectionCommand(
  input: SearchableShellWorkspace,
  command: string,
  options: { cwd: string, maxOutputLength: number },
): Promise<ShellObservation | undefined> {
  const segments = analyzeWorkspaceInspectionCommand(command)
  if (segments.length !== 1 || segments[0]?.separatorAfter) return undefined
  if (hasRedirect(wordsOf(segments[0]))) return undefined

  const started = Date.now()
  const words = wordsOf(segments[0])
  const executable = workspaceExecutable(words)
  if (!executable) return undefined

  if (executable.name === "ls") {
    const output = await directLs(input, words.slice(executable.index + 1), options.cwd)
    return finalizeDirectObservation({
      command,
      cwd: options.cwd,
      durationMs: Date.now() - started,
      maxOutputLength: options.maxOutputLength,
      stdout: output,
    })
  }

  if (executable.name === "find") {
    const output = await directFind(input, words.slice(executable.index + 1), options.cwd)
    if (typeof output !== "string") return undefined
    return finalizeDirectObservation({
      command,
      cwd: options.cwd,
      durationMs: Date.now() - started,
      maxOutputLength: options.maxOutputLength,
      stdout: output,
    })
  }
}

function finalizeDirectObservation(input: {
  command: string
  cwd: string
  durationMs: number
  maxOutputLength: number
  stderr?: string
  stdout: string
}): ShellObservation {
  return applyOutputLimit({
    command: input.command,
    cwd: input.cwd,
    durationMs: input.durationMs,
    event: "command_finished",
    exitCode: 0,
    stderr: input.stderr || "",
    stdout: input.stdout,
  }, input.maxOutputLength)
}

function applyOutputLimit(result: ShellObservation, maxLength: number): ShellObservation {
  const next: ShellObservation = { ...result, maxOutputLength: maxLength }
  let truncated = false
  if (next.stdout.length > maxLength) {
    next.stdout = `${next.stdout.slice(0, maxLength)}\n[output truncated to ${maxLength} characters]\n`
    truncated = true
  }
  if (next.stderr.length > maxLength) {
    next.stderr = `${next.stderr.slice(0, maxLength)}\n[output truncated to ${maxLength} characters]\n`
    truncated = true
  }
  return truncated ? { ...next, outputTruncated: true } : next
}

async function directLs(input: SearchableShellWorkspace, args: string[], cwd: string) {
  const parsed = parseLsArgs(args)
  const chunks: string[] = []

  for (const [index, path] of parsed.paths.entries()) {
    const resolved = resolveWorkspaceShellPath(cwd, path)
    const stat = await input.stat(resolved)
    if (parsed.paths.length > 1) {
      if (index > 0) chunks.push("\n")
      chunks.push(`${path}:\n`)
    }
    if (stat.type === "file") {
      chunks.push(formatLsEntries([stat], {
        all: false,
        basePath: parentPath(stat.path),
        long: parsed.long,
      }))
      continue
    }
    const entries = await input.list(resolved, { recursive: false })
    chunks.push(formatLsEntries(entries, {
      all: parsed.all,
      basePath: resolved,
      long: parsed.long,
    }))
  }

  return chunks.join("")
}

function parseLsArgs(args: string[]) {
  const paths: string[] = []
  let all = false
  let long = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") {
      paths.push(...args.slice(index + 1))
      break
    }
    if (arg === "-I" || arg === "--ignore") {
      index += 1
      continue
    }
    if (arg.startsWith("--ignore=")) continue
    if (arg.startsWith("-") && arg !== "-") {
      all ||= arg.includes("a") || arg.includes("A")
      long ||= arg.includes("l")
      continue
    }
    paths.push(arg)
  }

  return {
    all,
    long,
    paths: paths.length ? paths : ["."],
  }
}

function formatLsEntries(entries: ShellEntry[], options: { all: boolean, basePath: string, long: boolean }) {
  const sorted = [...entries].sort((left, right) =>
    Number(left.type === "directory") - Number(right.type === "directory")
    || left.path.localeCompare(right.path),
  )
  if (!options.long) {
    return sorted.map(entry => lsEntryName(options.basePath, entry)).join("\n") + (sorted.length ? "\n" : "")
  }

  const rows: string[] = [`total ${sorted.length}`]
  if (options.all) {
    rows.push(formatLsLongEntry(".", { path: options.basePath, type: "directory" }))
    rows.push(formatLsLongEntry("..", { path: parentPath(options.basePath), type: "directory" }))
  }
  rows.push(...sorted.map(entry => formatLsLongEntry(lsEntryName(options.basePath, entry), entry)))
  return `${rows.join("\n")}\n`
}

function formatLsLongEntry(name: string, entry: ShellEntry | ShellStat) {
  const directory = entry.type === "directory"
  const mode = directory ? "drwxr-xr-x" : "-rw-r--r--"
  const size = String(directory ? 0 : entry.size || 0).padStart(5)
  return `${mode} 1 user user ${size} Jan  1  1970 ${name}${directory && name !== "." && name !== ".." ? "/" : ""}`
}

function lsEntryName(basePath: string, entry: ShellEntry | ShellStat) {
  return basePath ? entry.path.slice(basePath.length + 1) : entry.path
}

async function directFind(input: SearchableShellWorkspace, args: string[], cwd: string): Promise<string | undefined> {
  const parsed = parseFindArgs(args)
  if (!parsed) return undefined

  const matches: string[] = []
  for (const path of parsed.paths) {
    const rootPath = resolveWorkspaceShellPath(cwd, path)
    const root = await input.stat(rootPath)
    const entries = [root, ...await input.list(rootPath, { recursive: true })]
    for (const entry of entries) {
      if (!findEntryWithinDepth(rootPath, entry.path, parsed.maxDepth)) continue
      if (parsed.type && entry.type !== parsed.type) continue
      if (parsed.name && !globNameMatches(parsed.name, basename(entry.path))) continue
      matches.push(entry.path || ".")
    }
  }

  return matches.join("\n") + (matches.length ? "\n" : "")
}

function parseFindArgs(args: string[]) {
  if (args.some(arg => arg === "-exec" || arg === "-ok" || arg === "-delete" || arg === "-print0")) return undefined
  if (args[0] === "-H" || args[0] === "-L" || args[0] === "-P") return undefined

  const paths: string[] = []
  let index = 0
  if (args[index] === "--") index += 1
  while (index < args.length) {
    const arg = args[index]!
    if (arg.startsWith("-")) break
    paths.push(arg)
    index += 1
  }
  if (!paths.length) paths.push(".")

  let maxDepth: number | undefined
  let name: string | undefined
  let type: "directory" | "file" | undefined

  while (index < args.length) {
    const arg = args[index]!
    if (arg === "-name") {
      name = args[index + 1]
      index += 2
      continue
    }
    if (arg === "-type") {
      const value = args[index + 1]
      if (value === "f") type = "file"
      else if (value === "d") type = "directory"
      else return undefined
      index += 2
      continue
    }
    if (arg === "-maxdepth") {
      const value = Number(args[index + 1])
      if (!Number.isInteger(value) || value < 0) return undefined
      maxDepth = value
      index += 2
      continue
    }
    if (arg.startsWith("-maxdepth=")) {
      const value = Number(arg.slice("-maxdepth=".length))
      if (!Number.isInteger(value) || value < 0) return undefined
      maxDepth = value
      index += 1
      continue
    }
    if (arg === "-print") {
      index += 1
      continue
    }
    return undefined
  }

  return { maxDepth, name, paths, type }
}

function findEntryWithinDepth(rootPath: string, entryPath: string, maxDepth: number | undefined) {
  if (maxDepth === undefined) return true
  if (entryPath === rootPath) return maxDepth >= 0
  const relative = rootPath ? entryPath.slice(rootPath.length + 1) : entryPath
  const depth = relative ? relative.split("/").length : 0
  return depth <= maxDepth
}

function globNameMatches(pattern: string, name: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`).test(name)
}

function basename(path: string) {
  return path.split("/").filter(Boolean).at(-1) || "."
}

function parentPath(path: string) {
  const parent = posix.dirname(path)
  return parent === "." ? "" : parent
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

function wordsOf(segment: ReturnType<typeof analyzeWorkspaceInspectionCommand>[number]) {
  return segment.words
}

function hasRedirect(words: string[]) {
  return words.some(word => /^(?:\d*)[<>]/.test(word))
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
