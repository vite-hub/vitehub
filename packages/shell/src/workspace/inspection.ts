import { posix } from "node:path"

import { createJustBashProvider } from "../providers/just-bash.ts"
import { createShellRuntime } from "../runtime/index.ts"
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
    for (const segment of splitShellCommandSegments(command)) {
      const words = parseShellWords(segment.command)
      if (isBroadWorkspaceSearch(words, broadSearchPaths, segment.followsPipe)) return broadWorkspaceSearchFeedback(broadSearchPaths)
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
    for (const segment of splitShellCommandSegments(command)) {
      if (skipAndChain) {
        skipAndChain = segment.separatorAfter === "&&"
        continue
      }
      if (skipOrChain) {
        skipOrChain = segment.separatorAfter === "||"
        continue
      }
      const words = parseShellWords(segment.command)
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
      for (const path of shellPathArguments(words)) {
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

function isBroadWorkspaceSearch(words: string[], broadSearchPaths: string[] = [], followsPipe = false) {
  const name = words[0]
  if (name === "rg" || name === "grep") {
    const paths = commandPathArguments(words)
    return (paths.length === 0 && !(name === "grep" && followsPipe))
      || paths.length > 4
      || paths.some(path => isBroadWorkspacePath(path, broadSearchPaths))
  }
  if (name === "find") {
    const paths = findPathArguments(words)
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
    for (const segment of splitShellCommandSegments(command)) {
      const words = parseShellWords(segment.command)
      if (words[0] !== "rg" && words[0] !== "grep") continue
      const paths = commandPathArguments(words)
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

function shellPathArguments(words: string[]) {
  switch (words[0]) {
    case "rg":
    case "grep":
      return commandPathArguments(words)
    case "find":
      return findPathArguments(words)
    case "cat":
    case "head":
    case "tail":
    case "wc":
    case "ls":
      return fileCommandPathArguments(words)
    default:
      return []
  }
}

function findPathArguments(words: string[]) {
  const paths: string[] = []
  let collectingPaths = true
  for (const arg of words.slice(1)) {
    if (isShellOperator(arg)) break
    if (collectingPaths && isFindLeadingOption(arg)) continue
    if (arg.startsWith("-")) break
    collectingPaths = false
    paths.push(arg)
  }
  return paths
}

function fileCommandPathArguments(words: string[]) {
  const paths: string[] = []
  for (let index = 1; index < words.length; index++) {
    const arg = words[index]!
    if (arg === "--") {
      paths.push(...pathArgumentsUntilShellBoundary(words.slice(index + 1)))
      break
    }
    if (isShellOperator(arg)) break
    if (arg.startsWith("-")) {
      if (takesFileCommandOptionValue(arg)) index += 1
      continue
    }
    paths.push(arg)
  }
  return paths
}

function isShellOperator(arg: string) {
  return arg === "&&" || arg === "||" || isRedirectOperator(arg)
}

function isRedirectOperator(arg: string) {
  return /^(?:\d*)[<>]+&?\d*$/.test(arg) || /^(?:\d*)[<>]/.test(arg)
}

function isFindLeadingOption(arg: string) {
  return arg === "-H" || arg === "-L" || arg === "-P"
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

function commandPathArguments(words: string[]) {
  const args = words.slice(1)
  const paths: string[] = []
  let sawPattern = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") {
      paths.push(...searchPathArgumentsAfterTerminator(args.slice(index + 1), sawPattern))
      break
    }
    if (isShellOperator(arg)) break
    if (arg.startsWith("-")) {
      if (takesOptionValue(arg)) {
        if (takesSearchPatternOptionValue(arg)) sawPattern = true
        index += 1
      }
      else if (takesInlineOptionValue(arg)) {
        continue
      }
      else if (takesInlineSearchPatternOptionValue(arg)) {
        sawPattern = true
      }
      continue
    }
    if (!sawPattern) {
      sawPattern = true
      continue
    }
    paths.push(arg)
  }
  return paths
}

function searchPathArgumentsAfterTerminator(args: string[], sawPattern: boolean) {
  if (sawPattern) return pathArgumentsUntilShellBoundary(args)
  return pathArgumentsUntilShellBoundary(args.slice(1))
}

function takesOptionValue(arg: string) {
  return [
    "-A",
    "-B",
    "-C",
    "-e",
    "-f",
    "-g",
    "-m",
    "-T",
    "-t",
    "--after-context",
    "--before-context",
    "--context",
    "--glob",
    "--max-count",
    "--max-filesize",
    "--regexp",
    "--type",
    "--type-add",
    "--type-clear",
    "--type-not",
  ].includes(arg)
}

function takesInlineOptionValue(arg: string) {
  return arg.startsWith("--max-filesize=")
    || arg.startsWith("--type=")
    || arg.startsWith("--type-add=")
    || arg.startsWith("--type-clear=")
    || arg.startsWith("--type-not=")
}

function takesSearchPatternOptionValue(arg: string) {
  return arg === "-e" || arg === "-f" || arg === "--regexp"
}

function takesInlineSearchPatternOptionValue(arg: string) {
  return arg.startsWith("--regexp=")
    || (arg.startsWith("-e") && arg !== "-e")
    || (arg.startsWith("-f") && arg !== "-f")
}

function takesFileCommandOptionValue(arg: string) {
  return arg === "-c" || arg === "-n" || arg === "--bytes" || arg === "--lines" || takesOptionValue(arg)
}

function pathArgumentsUntilShellBoundary(args: string[]) {
  const paths: string[] = []
  for (const arg of args) {
    if (isShellOperator(arg)) break
    paths.push(arg)
  }
  return paths
}

function splitShellCommandSegments(command: string) {
  const segments: Array<{ command: string, followsPipe: boolean, separatorAfter?: "&&" | "||" | "|" | ";" | "\n" }> = []
  let current = ""
  let quote: "'" | "\"" | undefined
  let escaped = false
  let followsPipe = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\") {
      current += char
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      current += char
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      current += char
      continue
    }
    const next = command[index + 1]
    if (char === "&" && next === "&") {
      segments.push({ command: current, followsPipe, separatorAfter: "&&" })
      current = ""
      followsPipe = false
      index += 1
      continue
    }
    if (char === "|" && next === "|") {
      segments.push({ command: current, followsPipe, separatorAfter: "||" })
      current = ""
      followsPipe = false
      index += 1
      continue
    }
    if (char === "|" || char === ";" || char === "\n") {
      segments.push({ command: current, followsPipe, separatorAfter: char })
      current = ""
      followsPipe = char === "|"
      continue
    }
    current += char
  }
  segments.push({ command: current, followsPipe })
  return segments
}

function parseShellWords(command: string) {
  const words: string[] = []
  let current = ""
  let quote: "'" | "\"" | undefined
  let escaped = false
  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current) words.push(current)
  return words
}
