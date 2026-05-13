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
  timeout?: number
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
  const timeout = options.timeout || 30_000
  const preflight = preflightWorkspaceInspectionCommand(command)
  if (preflight) return preflight
  const runtime = createJustBashRuntime({
    commands: options.commands,
    cwd: options.cwd || workspaceMountPoint,
    fs: options.fs,
  })
  const result = await Promise.race([
    runtime.exec(command, { cwd: options.cwd || workspaceMountPoint, timeout }),
    new Promise<ShellRuntimeExecResult>(resolve => setTimeout(() => resolve({
      exitCode: null,
      stderr: `[vitehub] Workspace shell command timed out after ${timeout}ms.`,
      stdout: "",
    }), timeout)),
  ])

  return {
    exitCode: result.exitCode,
    stderr: applyOutputLimit(result.stderr, maxOutputLength),
    stdout: applyOutputLimit(result.stdout, maxOutputLength),
  }
}

function preflightWorkspaceInspectionCommand(command: string): ShellRuntimeExecResult | undefined {
  try {
    for (const segment of splitShellSegments(command)) {
      const words = parseShellWords(segment)
      if (isBroadWorkspaceSearch(words)) {
        return {
          exitCode: 126,
          stderr: "[vitehub] Workspace root search is too broad. Use a narrow mounted source or subdirectory path instead.\n",
          stdout: "",
        }
      }
    }
  }
  catch {
    return undefined
  }
}

function isBroadWorkspaceSearch(words: string[]) {
  const name = words[0]
  if (name !== "rg") return false

  const paths = commandPathArguments(words)
  return paths.length === 0 || paths.some(path => path === "." || path === "./" || path === "/" || path === workspaceMountPoint)
}

function commandPathArguments(words: string[]) {
  const args = words.slice(1)
  const paths: string[] = []
  let sawPattern = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") {
      paths.push(...args.slice(index + 1))
      break
    }
    if (arg.startsWith("-")) {
      if (takesOptionValue(arg)) index += 1
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

function takesOptionValue(arg: string) {
  return [
    "-A",
    "-B",
    "-C",
    "-e",
    "-f",
    "-g",
    "-m",
    "--after-context",
    "--before-context",
    "--context",
    "--glob",
    "--max-count",
    "--regexp",
  ].includes(arg)
}

function splitShellSegments(command: string) {
  const segments: string[] = []
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
    if (char === "|" || char === ";" || char === "\n") {
      segments.push(current)
      current = ""
      continue
    }
    current += char
  }
  segments.push(current)
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
