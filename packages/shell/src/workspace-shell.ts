import { parseShellCommand } from "./parse.ts"
import { workspaceMountPoint } from "./workspace-fs.ts"

import type { IFileSystem } from "just-bash"
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
  provider?: "cloudflare-shell" | "just-bash"
}

async function loadJustBashRuntime() {
  const runtimeModule = "./runtime.js"
  return await import(/* @vite-ignore */ runtimeModule) as typeof import("./runtime.ts")
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
  input: SearchableShellWorkspace,
  command: string,
  options: WorkspaceInspectionCommandOptions,
): Promise<ShellRuntimeExecResult> {
  const resolved = {
    ...options,
    cwd: options.cwd || workspaceMountPoint,
    maxOutputLength: options.maxOutputLength || 30_000,
    provider: options.provider || "just-bash",
  }
  let pipeline: WorkspacePipeline
  try {
    pipeline = splitWorkspacePipeline(command)
  }
  catch (error) {
    return {
      exitCode: 126,
      stderr: applyOutputLimit(`${error instanceof Error ? error.message : String(error)}\n`, resolved.maxOutputLength),
      stdout: "",
    }
  }

  const words = tryParseCommand(pipeline.command)
  const name = words[0]

  if (name && isSearchCommand(name)) {
    const result = await runSearchCommand(input, pipeline.command, name, resolved)
    return {
      ...result,
      stdout: applyOutputLimit(applyPipelinePostprocess(result.stdout, pipeline.postprocess), resolved.maxOutputLength),
    }
  }

  if (resolved.provider === "cloudflare-shell") {
    return await runCloudflareWorkspaceInspectionCommand(input, pipeline, resolved)
  }

  const { createJustBashRuntime, withShellRuntimePolicy } = await loadJustBashRuntime()
  const runtime = withShellRuntimePolicy(createJustBashRuntime({
    commands: resolved.commands,
    cwd: resolved.cwd,
    fs: resolved.fs as IFileSystem & { writeFs: boolean },
  }), {
    allowedCommands: resolved.commands,
    singleCommand: true,
  })
  const result = await runtime.exec(pipeline.command, { cwd: resolved.cwd })
  const traversalArg = findTraversalArg(pipeline.command)
  const stderr = traversalArg && result.exitCode && /No such file or directory/.test(result.stderr)
    ? `[vitehub] Workspace path escapes the workspace root: "${traversalArg}".\n`
    : result.stderr
  const stdout = result.exitCode
    ? result.stdout
    : applyPipelinePostprocess(await normalizeShellStdout(input, pipeline.command, result.stdout), pipeline.postprocess)

  return {
    exitCode: result.exitCode ?? 0,
    stderr: applyOutputLimit(stderr, resolved.maxOutputLength),
    stdout: applyOutputLimit(stdout, resolved.maxOutputLength),
  }
}

async function runCloudflareWorkspaceInspectionCommand(
  input: SearchableShellWorkspace,
  pipeline: WorkspacePipeline,
  options: Required<WorkspaceInspectionCommandOptions>,
): Promise<ShellRuntimeExecResult> {
  try {
    const words = parseShellCommand(pipeline.command)
    const [name, ...args] = words
    if (!name) return { exitCode: 0, stderr: "", stdout: "" }
    if (!options.commands.includes(name)) {
      return {
        exitCode: 126,
        stderr: applyOutputLimit(`Unsupported workspace shell command: ${name}\n`, options.maxOutputLength),
        stdout: "",
      }
    }

    const cwd = cleanWorkspaceShellPath(options.cwd)
    let stdout = ""
    let exitCode = 0

    if (name === "pwd") {
      stdout = `${workspaceMountPoint}${cwd ? `/${cwd}` : ""}\n`
    }
    else if (name === "ls") {
      const path = resolveShellPath(args.find(arg => !arg.startsWith("-")), cwd)
      stdout = formatList(await input.list(path, { recursive: false }), path)
    }
    else if (name === "find") {
      stdout = await runFindCommand(input, args, cwd)
    }
    else if (name === "cat") {
      stdout = (await Promise.all(args.map(path => input.readFile(resolveShellPath(path, cwd))))).join("")
    }
    else if (name === "head") {
      const { count, rest } = parseCountOption(args)
      stdout = firstLines(String(await input.readFile(resolveShellPath(rest[0], cwd))), count)
    }
    else if (name === "tail") {
      const { count, rest } = parseCountOption(args)
      stdout = lastLines(String(await input.readFile(resolveShellPath(rest[0], cwd))), count)
    }
    else if (name === "wc" && args[0] === "-l") {
      const path = resolveShellPath(args[1], cwd)
      stdout = `${lineCount(String(await input.readFile(path)))} ${args[1]}\n`
    }
    else if (name === "grep" || name === "rg") {
      const result = await runSearchCommand(input, pipeline.command, name, options)
      exitCode = result.exitCode ?? 0
      stdout = result.stdout
    }
    else {
      return {
        exitCode: 126,
        stderr: applyOutputLimit(`Unsupported workspace shell command: ${name}\n`, options.maxOutputLength),
        stdout: "",
      }
    }

    return {
      exitCode,
      stderr: "",
      stdout: applyOutputLimit(applyPipelinePostprocess(stdout, pipeline.postprocess), options.maxOutputLength),
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      exitCode: message.startsWith("Unsupported shell syntax:") ? 126 : 1,
      stderr: applyOutputLimit(`${message}\n`, options.maxOutputLength),
      stdout: "",
    }
  }
}

interface WorkspacePipeline {
  command: string
  postprocess?: string[]
}

function splitWorkspacePipeline(command: string): WorkspacePipeline {
  const parts: string[] = []
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
    if (char === "|") {
      parts.push(current.trim())
      current = ""
      continue
    }
    current += char
  }

  if (quote) throw new Error("Unsupported shell syntax: unterminated quote.")
  parts.push(current.trim())

  if (parts.length === 1) return { command: parts[0]!, postprocess: undefined }
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Unsupported shell syntax: only a single workspace command is supported.")
  }

  const postprocess = parseShellCommand(parts[1])
  const [name, ...args] = postprocess
  if ((name !== "head" && name !== "tail") || args.some(arg => /[|;&<>`$()]/.test(arg))) {
    throw new Error("Unsupported shell syntax: only a single workspace command is supported.")
  }
  const { rest } = parseCountOption(args)
  if (rest.length) throw new Error("Unsupported shell syntax: only a single workspace command is supported.")

  return { command: parts[0], postprocess }
}

function applyPipelinePostprocess(stdout: string, postprocess?: string[]) {
  if (!postprocess) return stdout
  const [name, ...args] = postprocess
  const { count, rest } = parseCountOption(args)
  if (rest.length) throw new Error("Unsupported shell syntax: only a single workspace command is supported.")
  if (name === "head") return firstLines(stdout, count)
  if (name === "tail") return lastLines(stdout, count)
  throw new Error("Unsupported shell syntax: only a single workspace command is supported.")
}

function parseCountOption(args: string[]) {
  if (args[0] === "-n") {
    const count = Number.parseInt(args[1] || "", 10)
    if (!Number.isFinite(count) || count < 0) throw new Error("[vitehub] Invalid line count.")
    return { count, rest: args.slice(2) }
  }
  return { count: 10, rest: args }
}

function firstLines(text: string, count: number) {
  const lines = text.split("\n")
  const hasTrailingNewline = lines.at(-1) === ""
  const selected = lines.slice(0, count)
  return selected.join("\n") + (hasTrailingNewline || selected.length < lines.length ? "\n" : "")
}

function lastLines(text: string, count: number) {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")
  return lines.slice(-count).join("\n") + (lines.length ? "\n" : "")
}

function lineCount(text: string) {
  if (!text) return 0
  return text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length
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
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "")
  const parts = trimmed.split("/").filter(part => part && part !== ".")

  if (raw.startsWith("/") || parts.some(part => part === "..")) {
    throw new Error(`[vitehub] Workspace path escapes the workspace root: "${path}".`)
  }
  if (parts[0] === ".git" || parts[0] === ".vitehub") {
    throw new Error(`[vitehub] Workspace path is reserved: "${path}".`)
  }

  return parts.join("/")
}

function resolveShellPath(path: string | undefined, cwd: string) {
  const input = path || "."
  if (input === "." || input === "./") return cwd
  if (input.startsWith("/workspace/")) return cleanWorkspaceShellPath(input)
  if (input.startsWith("/")) throw new Error(`[vitehub] Workspace path escapes the workspace root: "${input}".`)
  return normalizeSafeShellPath(cwd ? `${cwd}/${input}` : input)
}

function displayPath(path: string, cwd: string) {
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

function formatList(entries: Awaited<ReturnType<SearchableShellWorkspace["list"]>>, prefix: string) {
  return entries
    .map((entry) => {
      const name = prefix ? entry.path.slice(prefix.length + 1) : entry.path
      return `${name}${entry.type === "directory" ? "/" : ""}`
    })
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .join("\n") + (entries.length ? "\n" : "")
}

function globPatternToRegExp(pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`)
}

async function runFindCommand(input: SearchableShellWorkspace, args: string[], cwd: string) {
  const root = resolveShellPath(args[0] && !args[0].startsWith("-") ? args[0] : ".", cwd)
  const nameIndex = args.indexOf("-name")
  const pattern = nameIndex >= 0 ? args[nameIndex + 1] : undefined
  const matcher = pattern ? globPatternToRegExp(pattern) : undefined
  const entries = await input.list(root, { recursive: true })
  const lines = entries
    .filter(entry => !matcher || matcher.test(entry.path.split("/").at(-1) || entry.path))
    .map(entry => displayPath(entry.path, cwd))
    .sort((left, right) => left.localeCompare(right))
  return `${lines.join("\n")}${lines.length ? "\n" : ""}`
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
    if (word === "--ignore-case") {
      caseSensitive = false
      continue
    }
    if (word === "--line-number") continue
    if (word === "-e" || word === "--regexp") {
      pattern = rest[index + 1]
      index += 1
      continue
    }
    if (word.startsWith("-") && word.length > 1 && !word.startsWith("--")) {
      for (const flag of word.slice(1)) {
        if (flag === "i") caseSensitive = false
        else if (flag === "n" || flag === "r" || flag === "R") continue
        else throw new Error(`[vitehub] Unsupported workspace search flag: -${flag}.`)
      }
      continue
    }
    if (word.startsWith("-")) {
      throw new Error(`[vitehub] Unsupported workspace search flag: ${word}.`)
    }
    if (!pattern) {
      pattern = word
      continue
    }
    const path = cleanWorkspaceShellPath(word)
    if (path) paths.push(path)
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
