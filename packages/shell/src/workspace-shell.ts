import { createJustBashRuntime, parseShellCommand, withShellRuntimePolicy } from "./runtime.ts"
import { workspaceMountPoint } from "./workspace-fs.ts"

import type {
  SearchableShellWorkspace,
  ShellRuntimeExecResult,
  ShellSearchHit,
  ShellSearchQuery,
  WorkspaceShellFileSystem,
} from "./types.ts"

interface WorkspaceInspectionCommandOptions {
  commands: string[]
  cwd?: string
  fs: WorkspaceShellFileSystem
  maxOutputLength?: number
}

export function cleanWorkspaceShellPath(path = "."): string {
  let normalized = path.trim() || "."
  if (normalized === "." || normalized === "./" || normalized === "/" || normalized === workspaceMountPoint) return ""
  normalized = normalized.replace(/^\/workspace\/?/, "")
  return normalizeSafeShellPath(normalized)
}

export function cleanWorkspaceMutationPath(path: string): string {
  const normalized = cleanWorkspaceShellPath(path)
  if (!normalized) throw new Error("[vitehub] Workspace root is not a valid mutation target.")
  return normalized
}

export async function runWorkspaceInspectionCommand(
  input: SearchableShellWorkspace,
  command: string,
  options: WorkspaceInspectionCommandOptions,
): Promise<ShellRuntimeExecResult> {
  const resolved = {
    ...options,
    cwd: options.cwd || workspaceMountPoint,
    maxOutputLength: options.maxOutputLength || 30_000,
  }
  const words = tryParseCommand(command)
  const name = words[0]

  if (name && isSearchCommand(name)) {
    return await runSearchCommand(input, command, name, resolved)
  }

  const runtime = withShellRuntimePolicy(createJustBashRuntime({
    commands: resolved.commands,
    cwd: resolved.cwd,
    fs: resolved.fs,
  }), {
    allowedCommands: resolved.commands,
    singleCommand: true,
  })
  const result = await runtime.exec(command, { cwd: resolved.cwd })
  const traversalArg = findTraversalArg(command)
  const stderr = traversalArg && result.exitCode && /No such file or directory/.test(result.stderr)
    ? `[vitehub] Workspace path escapes the workspace root: "${traversalArg}".\n`
    : result.stderr
  const stdout = result.exitCode ? result.stdout : await normalizeShellStdout(input, command, result.stdout)

  return {
    exitCode: result.exitCode ?? 0,
    stderr: applyOutputLimit(stderr, resolved.maxOutputLength),
    stdout: applyOutputLimit(stdout, resolved.maxOutputLength),
  }
}

async function runSearchCommand(
  input: SearchableShellWorkspace,
  command: string,
  name: string,
  options: Required<WorkspaceInspectionCommandOptions>,
): Promise<ShellRuntimeExecResult> {
  if (!options.commands.includes(name)) {
    return {
      exitCode: 126,
      stderr: applyOutputLimit(`Unsupported workspace shell command: ${name}\n`, options.maxOutputLength),
      stdout: "",
    }
  }
  try {
    const query = parseSearchCommand(command, options.cwd)
    const hits = await input.search(query)
    return {
      exitCode: hits.length ? 0 : 1,
      stderr: "",
      stdout: applyOutputLimit(formatSearchHits(hits), options.maxOutputLength),
    }
  }
  catch (error) {
    return {
      exitCode: 1,
      stderr: applyOutputLimit(`${error instanceof Error ? error.message : String(error)}\n`, options.maxOutputLength),
      stdout: "",
    }
  }
}

function normalizeSafeShellPath(path = ""): string {
  const raw = path.replace(/\\/g, "/")
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "")
  const parts = normalized.split("/").filter(Boolean)

  if (raw.startsWith("/") || parts.some(part => part === "." || part === "..")) {
    throw new Error(`[vitehub] Workspace path escapes the workspace root: "${path}".`)
  }
  if (parts[0] === ".git" || parts[0] === ".vitehub") {
    throw new Error(`[vitehub] Workspace path is reserved: "${path}".`)
  }

  return normalized
}

function tryParseCommand(command: string): string[] {
  try {
    return parseShellCommand(command)
  }
  catch {
    return []
  }
}

async function normalizeShellStdout(input: SearchableShellWorkspace, command: string, stdout: string) {
  const words = parseShellCommand(command)
  const [name] = words
  if (name === "find") return stdout.replace(/^\.\/+/gm, "")
  if (name !== "ls") return stdout

  const hasFlags = words.slice(1).some(word => word.startsWith("-"))
  if (hasFlags) return stdout

  const rawPath = words[1] || "."
  const prefix = cleanWorkspaceShellPath(rawPath)
  const entries = await input.list(prefix, { recursive: false })
  const directories = new Set(entries.filter(entry => entry.type === "directory").map((entry) => {
    if (!prefix) return entry.path
    return entry.path.slice(prefix.length + 1)
  }))

  return stdout
    .split("\n")
    .map((line) => {
      if (!line || line.endsWith("/")) return line
      return directories.has(line) ? `${line}/` : line
    })
    .join("\n")
}

function findTraversalArg(command: string) {
  try {
    return parseShellCommand(command).find(word => /(?:^|\/)\.\.(?:\/|$)/.test(word))
  }
  catch {
    return undefined
  }
}

function applyOutputLimit(output: string, max: number) {
  if (output.length <= max) return output
  return `${output.slice(0, max)}\n[output truncated to ${max} characters]\n`
}

function isSearchCommand(command: string) {
  return command === "grep" || command === "rg"
}

function parseSearchCommand(command: string, cwd: string): ShellSearchQuery {
  const words = parseShellCommand(command)
  const [name, ...rest] = words
  if (!name || !isSearchCommand(name)) throw new Error("Unsupported search command.")

  let caseSensitive = true
  let pattern: string | undefined
  const paths: string[] = []

  for (let index = 0; index < rest.length; index++) {
    const word = rest[index]
    if (word === "-i" || word === "--ignore-case") {
      caseSensitive = false
      continue
    }
    if (word === "-n" || word === "--line-number") continue
    if (word === "-e" || word === "--regexp") {
      pattern = rest[index + 1]
      index += 1
      continue
    }
    if (word.startsWith("-")) {
      throw new Error(`[vitehub] Unsupported workspace search flag: ${word}.`)
    }
    if (!pattern) {
      pattern = word
      continue
    }
    paths.push(cleanWorkspaceShellPath(word))
  }

  if (!pattern) throw new Error("[vitehub] Workspace search commands require a pattern.")

  return {
    caseSensitive,
    cwd: cleanWorkspaceShellPath(cwd),
    limit: 200,
    paths,
    pattern,
    regex: true,
  }
}

function formatSearchHits(hits: ShellSearchHit[]) {
  return hits.map(hit => `${hit.path}:${hit.line}:${hit.text}`).join("\n") + (hits.length ? "\n" : "")
}
