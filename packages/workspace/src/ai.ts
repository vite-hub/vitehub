import { basename } from "node:path"

import { jsonSchema, tool, type Tool } from "ai"

import { WorkspaceError } from "./errors.ts"
import { matchesAny, normalizeSafeWorkspacePath } from "./path.ts"
import { useWorkspaceAssets } from "./asset-registry.ts"

import type { Workspace, WorkspaceAssets, WorkspaceContent } from "./types.ts"

export interface WorkspaceShellResult {
  exitCode: number
  stderr: string
  stdout: string
}

export interface CreateWorkspaceToolsOptions {
  cwd?: string
  maxOutputLength?: number
}

export interface WorkspaceAiTools {
  bash: Tool<{ command: string }, WorkspaceShellResult>
  readFile: Tool<{ path: string }, string>
}

interface WorkspaceReader {
  getKeys(): Promise<string[]>
  readText(path: string): Promise<string | null>
}

const defaultMaxOutputLength = 30_000
const workspaceInstructionsFile = "AGENTS.md"
const blockedCommands = new Set([
  "bun",
  "chmod",
  "chown",
  "cp",
  "curl",
  "dd",
  "git",
  "mv",
  "node",
  "npm",
  "pnpm",
  "python",
  "python3",
  "rm",
  "sh",
  "wget",
  "yarn",
])

function isWorkspaceAssets(input: Workspace | WorkspaceAssets): input is WorkspaceAssets {
  return "getKeys" in input
}

function decodeContent(content: WorkspaceContent) {
  return typeof content === "string" ? content : new TextDecoder().decode(content)
}

function createReader(input: Workspace | WorkspaceAssets): WorkspaceReader {
  if (isWorkspaceAssets(input)) {
    return {
      async getKeys() {
        return (await input.getKeys()).map(key => normalizeSafeWorkspacePath(key)).sort()
      },
      async readText(path) {
        const content = await input.getItem<WorkspaceContent>(path)
        return content === null ? null : decodeContent(content)
      },
    }
  }

  return {
    async getKeys() {
      const entries = await input.glob("**/*")
      return entries.filter(entry => entry.type === "file").map(entry => normalizeSafeWorkspacePath(entry.path)).sort()
    },
    async readText(path) {
      try {
        return decodeContent(await input.readFile(path, { encoding: "binary" }))
      }
      catch (error) {
        if (error instanceof WorkspaceError) return null
        throw error
      }
    },
  }
}

function parseCommand(command: string): string[] {
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

  if (escaped) current += "\\"
  if (quote) throw new Error("unterminated quote")
  if (current) words.push(current)
  return words
}

function hasUnsupportedShellSyntax(command: string) {
  return /(?:&&|\|\||[;|`<>]|\$\()/.test(command)
}

function cleanPath(path = ".") {
  let normalized = path.trim() || "."
  if (normalized === "." || normalized === "./" || normalized === "/" || normalized === "/workspace") return ""
  normalized = normalized.replace(/^\/workspace\/?/, "")
  return normalizeSafeWorkspacePath(normalized, { allowEmpty: true })
}

function isUnder(path: string, prefix: string) {
  return !prefix || path === prefix || path.startsWith(`${prefix}/`)
}

function lineCount(content: string) {
  if (!content) return 0
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length
}

function wordCount(content: string) {
  return content.trim() ? content.trim().split(/\s+/).length : 0
}

function byteCount(content: string) {
  return new TextEncoder().encode(content).byteLength
}

function contentLines(content: string) {
  return (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n")
}

function applyOutputLimit(output: string, max: number) {
  if (output.length <= max) return output
  return `${output.slice(0, max)}\n[output truncated to ${max} characters]\n`
}

function ok(stdout: string, maxOutputLength: number, stderr = ""): WorkspaceShellResult {
  return {
    exitCode: 0,
    stderr: applyOutputLimit(stderr, maxOutputLength),
    stdout: applyOutputLimit(stdout, maxOutputLength),
  }
}

function fail(message: string, exitCode = 1): WorkspaceShellResult {
  return {
    exitCode,
    stderr: `${message}\n`,
    stdout: "",
  }
}

function childNames(keys: string[], dir: string) {
  const names = new Set<string>()
  for (const key of keys) {
    if (!isUnder(key, dir) || key === dir) continue
    const rest = dir ? key.slice(dir.length + 1) : key
    const [first, ...remaining] = rest.split("/")
    names.add(`${first}${remaining.length ? "/" : ""}`)
  }
  return [...names].sort()
}

async function readRequired(reader: WorkspaceReader, path: string) {
  const content = await reader.readText(path)
  if (content === null) throw new WorkspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
  return content
}

function parseCountArgs(args: string[], defaultCount = 10) {
  const paths: string[] = []
  let count = defaultCount
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "-n") {
      count = Number(args[++index])
    }
    else if (arg.startsWith("-n") && arg.length > 2) {
      count = Number(arg.slice(2))
    }
    else {
      paths.push(arg)
    }
  }
  return { count: Number.isFinite(count) && count >= 0 ? count : defaultCount, paths }
}

function parseWcArgs(args: string[]) {
  const flags = new Set<string>()
  const paths: string[] = []
  for (const arg of args) {
    if (arg.startsWith("-") && arg.length > 1) {
      for (const flag of arg.slice(1)) flags.add(flag)
    }
    else {
      paths.push(arg)
    }
  }
  if (!flags.size) {
    flags.add("l")
    flags.add("w")
    flags.add("c")
  }
  return { flags, paths }
}

function parseGrepArgs(args: string[]) {
  const paths: string[] = []
  let pattern: string | undefined
  let ignoreCase = false
  let listFiles = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--") {
      pattern ||= args[++index]
      paths.push(...args.slice(index + 1))
      break
    }
    if (!pattern && arg.startsWith("-") && arg !== "-") {
      if (arg === "-e") {
        pattern = args[++index]
      }
      else {
        if (arg.includes("i")) ignoreCase = true
        if (arg.includes("l")) listFiles = true
      }
      continue
    }
    if (!pattern) pattern = arg
    else paths.push(arg)
  }

  return { ignoreCase, listFiles, paths, pattern }
}

function matchingFiles(keys: string[], rawPaths: string[]) {
  if (!rawPaths.length) return keys
  const results = new Set<string>()
  for (const rawPath of rawPaths) {
    const path = cleanPath(rawPath)
    for (const key of keys) {
      if (key === path || isUnder(key, path)) results.add(key)
    }
  }
  return [...results].sort()
}

function isWorkspaceInstructionsPath(path: string) {
  return path === workspaceInstructionsFile || path.endsWith(`/${workspaceInstructionsFile}`)
}

export async function readWorkspaceInstructions(input: Workspace | WorkspaceAssets): Promise<string> {
  const reader = createReader(input)
  const keys = (await reader.getKeys()).filter(isWorkspaceInstructionsPath)
  const instructions = await Promise.all(keys.map(async key => await reader.readText(key)))
  return instructions.filter((content): content is string => content !== null).join("\n\n")
}

async function runShellCommand(reader: WorkspaceReader, command: string, options: Required<CreateWorkspaceToolsOptions>): Promise<WorkspaceShellResult> {
  if (hasUnsupportedShellSyntax(command)) {
    return fail("Unsupported shell syntax: only a single read-only workspace command is supported.", 126)
  }

  let words: string[]
  try {
    words = parseCommand(command)
  }
  catch (error) {
    return fail(error instanceof Error ? error.message : "Could not parse command.", 2)
  }

  if (!words.length) return ok("", options.maxOutputLength)
  const [name, ...args] = words
  if (blockedCommands.has(name)) return fail(`Command is not available in the read-only workspace shell: ${name}`, 126)

  const keys = await reader.getKeys()

  try {
    if (name === "pwd") return ok(`${options.cwd}\n`, options.maxOutputLength)

    if (name === "ls") {
      const dir = cleanPath(args.find(arg => !arg.startsWith("-")) || ".")
      if (keys.includes(dir)) return ok(`${basename(dir)}\n`, options.maxOutputLength)
      const names = childNames(keys, dir)
      return ok(names.length ? `${names.join("\n")}\n` : "", options.maxOutputLength)
    }

    if (name === "find") {
      const paths = args.filter((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-name")
      const nameIndex = args.indexOf("-name")
      const namePattern = nameIndex >= 0 ? args[nameIndex + 1] : undefined
      let files = matchingFiles(keys, paths.length ? paths : ["."])
      if (namePattern) files = files.filter(path => matchesAny(basename(path), namePattern))
      return ok(`${files.join("\n")}${files.length ? "\n" : ""}`, options.maxOutputLength)
    }

    if (name === "cat") {
      if (!args.length) return fail("cat: missing file operand")
      const chunks = await Promise.all(args.map(async path => await readRequired(reader, cleanPath(path))))
      return ok(chunks.join(""), options.maxOutputLength)
    }

    if (name === "head" || name === "tail") {
      const { count, paths } = parseCountArgs(args)
      if (!paths.length) return fail(`${name}: missing file operand`)
      const chunks = await Promise.all(paths.map(async (rawPath) => {
        const path = cleanPath(rawPath)
        const lines = contentLines(await readRequired(reader, path))
        const selected = name === "head" ? lines.slice(0, count) : lines.slice(-count)
        const body = selected.join("\n")
        return paths.length > 1 ? `==> ${path} <==\n${body}` : body
      }))
      return ok(`${chunks.join("\n")}\n`, options.maxOutputLength)
    }

    if (name === "wc") {
      const { flags, paths } = parseWcArgs(args)
      if (!paths.length) return fail("wc: missing file operand")
      const lines = await Promise.all(paths.map(async (rawPath) => {
        const path = cleanPath(rawPath)
        const content = await readRequired(reader, path)
        const counts: string[] = []
        if (flags.has("l")) counts.push(String(lineCount(content)))
        if (flags.has("w")) counts.push(String(wordCount(content)))
        if (flags.has("c") || flags.has("m")) counts.push(String(byteCount(content)))
        return `${counts.join(" ")} ${path}`
      }))
      return ok(`${lines.join("\n")}\n`, options.maxOutputLength)
    }

    if (name === "grep" || name === "rg") {
      const { ignoreCase, listFiles, paths, pattern } = parseGrepArgs(args)
      if (!pattern) return fail(`${name}: missing pattern`)
      let regex: RegExp
      try {
        regex = new RegExp(pattern, ignoreCase ? "i" : "")
      }
      catch {
        regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "i" : "")
      }
      const fileMatches = await Promise.all(matchingFiles(keys, paths).map(async (path) => {
        const content = await readRequired(reader, path)
        const matches = content.split("\n").flatMap((line, index) => regex.test(line)
          ? [listFiles ? path : `${path}:${index + 1}:${line}`]
          : [])
        return listFiles && matches.length ? [path] : matches
      }))
      const output = fileMatches.flat()
      const uniqueOutput = listFiles ? [...new Set(output)] : output
      return {
        exitCode: uniqueOutput.length ? 0 : 1,
        stderr: "",
        stdout: applyOutputLimit(`${uniqueOutput.join("\n")}${uniqueOutput.length ? "\n" : ""}`, options.maxOutputLength),
      }
    }
  }
  catch (error) {
    if (error instanceof WorkspaceError) return fail(error.message)
    throw error
  }

  return fail(`Unsupported read-only workspace command: ${name}`, 126)
}

export function createWorkspaceTools(input: Workspace | WorkspaceAssets, options: CreateWorkspaceToolsOptions = {}): WorkspaceAiTools {
  const reader = createReader(input)
  const resolved = {
    cwd: options.cwd || "/workspace",
    maxOutputLength: options.maxOutputLength || defaultMaxOutputLength,
  }

  return {
    bash: tool({
      description: "Run a read-only workspace shell command. Supported commands: pwd, ls, find, cat, head, tail, wc, grep, rg.",
      inputSchema: jsonSchema<{ command: string }>({
        additionalProperties: false,
        properties: {
          command: {
            description: "A single read-only workspace command to run.",
            type: "string",
          },
        },
        required: ["command"],
        type: "object",
      }),
      execute: async ({ command }) => await runShellCommand(reader, command, resolved),
    }),
    readFile: tool({
      description: "Read a text file from the workspace.",
      inputSchema: jsonSchema<{ path: string }>({
        additionalProperties: false,
        properties: {
          path: {
            description: "Workspace-relative file path to read.",
            type: "string",
          },
        },
        required: ["path"],
        type: "object",
      }),
      execute: async ({ path }) => {
        const normalized = cleanPath(path)
        const content = await reader.readText(normalized)
        if (content === null) throw new WorkspaceError(`[vitehub] Workspace file does not exist: ${normalized}.`)
        return applyOutputLimit(content, resolved.maxOutputLength)
      },
    }),
  }
}

export function useWorkspaceTools(name: string, options: CreateWorkspaceToolsOptions = {}): WorkspaceAiTools {
  return createWorkspaceTools(useWorkspaceAssets(name), options)
}
