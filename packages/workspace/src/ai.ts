import { basename, posix } from "node:path"

import { jsonSchema, tool, type Tool, type ToolSet } from "ai"

import { WorkspaceError } from "./errors.ts"
import { matchesAny, normalizeSafeWorkspacePath } from "./path.ts"

import type { Workspace, WorkspaceAssets, WorkspaceContent, WorkspaceStat, WriteFileOptions } from "./types.ts"

export interface WorkspaceShellResult {
  exitCode: number
  stderr: string
  stdout: string
}

export interface WorkspacePathResult {
  path: string
}

export interface WorkspaceMoveResult {
  from: string
  to: string
}

export interface WorkspaceReadOperations {
  list?: boolean
  read?: boolean
  search?: boolean
}

export interface WorkspaceWriteOperations {
  appendFile?: boolean
  copyPath?: boolean
  deletePath?: boolean
  makeDir?: boolean
  movePath?: boolean
  writeFile?: boolean
}

export type WorkspaceToolOperations = WorkspaceReadOperations & {
  write?: true | WorkspaceWriteOperations
}

export interface WorkspaceToolOptions<Operations extends WorkspaceToolOperations | undefined = undefined> {
  cwd?: string
  maxOutputLength?: number
  operations?: Operations
}

export interface WorkspaceReadToolOptions<Operations extends WorkspaceReadOperations | undefined = undefined> {
  cwd?: string
  maxOutputLength?: number
  operations?: Operations
}

type EnabledReadCapability<Operations, Key extends keyof WorkspaceReadOperations> = Operations extends Record<Key, infer Value>
  ? Value extends false ? false : true
  : true

type ShellEnabled<Operations> = true extends
  | EnabledReadCapability<Operations, "list">
  | EnabledReadCapability<Operations, "read">
  | EnabledReadCapability<Operations, "search">
  ? true
  : false

type ResolvedWriteOperations<Operations> = Operations extends { write: infer Write } ? Write : false

type WorkspaceWriteTools = {
  appendFile: Tool<{ content: string, path: string }, WorkspacePathResult>
  copyPath: Tool<{ from: string, overwrite?: boolean, to: string }, WorkspaceMoveResult>
  deletePath: Tool<{ force?: boolean, path: string, recursive?: boolean }, WorkspacePathResult>
  makeDir: Tool<{ path: string, recursive?: boolean }, WorkspacePathResult>
  movePath: Tool<{ from: string, overwrite?: boolean, to: string }, WorkspaceMoveResult>
  writeFile: Tool<{ content: string, mediaType?: string, path: string }, WorkspacePathResult>
}

type EnabledWriteTools<Selection> = Selection extends true
  ? WorkspaceWriteTools
  : Selection extends WorkspaceWriteOperations
    ? {
        [Key in keyof WorkspaceWriteTools as Key extends keyof Selection
          ? Selection[Key] extends true ? Key : never
          : never]: WorkspaceWriteTools[Key]
      }
    : {}

export type WorkspaceTools<Operations = undefined> = ((ShellEnabled<Operations> extends true
  ? { shell: Tool<{ command: string }, WorkspaceShellResult> }
  : {}) & EnabledWriteTools<ResolvedWriteOperations<Operations>>
  ) & ToolSet

interface WorkspaceReader {
  getKeys(): Promise<string[]>
  readText(path: string): Promise<string | null>
}

const defaultMaxOutputLength = 30_000

function isWorkspace(input: Workspace | WorkspaceAssets): input is Workspace {
  return "sync" in input
}

function decodeContent(content: WorkspaceContent) {
  return typeof content === "string" ? content : new TextDecoder().decode(content)
}

function createReader(input: Workspace | WorkspaceAssets): WorkspaceReader {
  return {
    async getKeys() {
      const entries = await input.list("", { recursive: true })
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

function cleanMutationPath(path: string, label = "path") {
  const normalized = cleanPath(path)
  if (!normalized) throw new WorkspaceError(`[vitehub] Workspace root is not a valid target for ${label}.`)
  return normalized
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

function describeShellCommands(commands: Set<string>) {
  return `Run a workspace inspection command in the simulated shell. Supported commands: ${[...commands].sort().join(", ")}. This does not execute a real shell.`
}

function resolveReadOperations(operations: WorkspaceReadOperations | WorkspaceToolOperations | undefined) {
  return {
    list: operations?.list !== false,
    read: operations?.read !== false,
    search: operations?.search !== false,
  }
}

function resolveWriteOperations(write: true | WorkspaceWriteOperations | undefined) {
  if (write === true) {
    return {
      appendFile: true,
      copyPath: true,
      deletePath: true,
      makeDir: true,
      movePath: true,
      writeFile: true,
    }
  }

  return {
    appendFile: write?.appendFile === true,
    copyPath: write?.copyPath === true,
    deletePath: write?.deletePath === true,
    makeDir: write?.makeDir === true,
    movePath: write?.movePath === true,
    writeFile: write?.writeFile === true,
  }
}

function shellCommandsFor(operations: ReturnType<typeof resolveReadOperations>) {
  const commands = new Set<string>()
  if (operations.list) {
    commands.add("pwd")
    commands.add("ls")
    commands.add("find")
  }
  if (operations.read) {
    commands.add("cat")
    commands.add("head")
    commands.add("tail")
    commands.add("wc")
  }
  if (operations.search) {
    commands.add("grep")
    commands.add("rg")
  }
  return commands
}

async function runShellCommand(
  reader: WorkspaceReader,
  command: string,
  options: { cwd: string, maxOutputLength: number },
  commands: Set<string>,
): Promise<WorkspaceShellResult> {
  if (hasUnsupportedShellSyntax(command)) {
    return fail("Unsupported shell syntax: only a single workspace command is supported.", 126)
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
  if (!commands.has(name)) return fail(`Unsupported workspace shell command: ${name}`, 126)

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

  return fail(`Unsupported workspace shell command: ${name}`, 126)
}

async function ensureMissingOrReplaceable(workspace: Workspace, path: string, overwrite: boolean) {
  const exists = await workspace.exists(path)
  if (!exists) return
  if (!overwrite) throw new WorkspaceError(`[vitehub] Workspace path already exists: ${path}.`)
  await workspace.rm(path, { recursive: true, force: true })
}

async function readWorkspaceStat(workspace: Workspace, path: string): Promise<WorkspaceStat> {
  return await workspace.stat(path)
}

async function copyWorkspacePath(workspace: Workspace, from: string, to: string, overwrite: boolean) {
  if (from === to) throw new WorkspaceError("[vitehub] Source and destination must be different.")
  const source = await readWorkspaceStat(workspace, from)
  if (source.type === "directory" && to.startsWith(`${from}/`)) {
    throw new WorkspaceError("[vitehub] Destination cannot be nested inside the source directory.")
  }

  const entries = source.type === "directory" ? await workspace.list(from, { recursive: true }) : []
  await ensureMissingOrReplaceable(workspace, to, overwrite)

  if (source.type === "file") {
    const content = await workspace.readFile(from, { encoding: "binary" })
    await workspace.writeFile(to, content, { mediaType: source.mediaType })
    return
  }

  await workspace.mkdir(to, { recursive: true })

  const directories = entries.filter(entry => entry.type === "directory").sort((left, right) => left.path.length - right.path.length)
  const files = entries.filter(entry => entry.type === "file").sort((left, right) => left.path.localeCompare(right.path))

  for (const entry of directories) {
    const relativePath = posix.relative(from, entry.path)
    await workspace.mkdir(posix.join(to, relativePath), { recursive: true })
  }

  for (const entry of files) {
    const relativePath = posix.relative(from, entry.path)
    const content = await workspace.readFile(entry.path, { encoding: "binary" })
    await workspace.writeFile(posix.join(to, relativePath), content, { mediaType: entry.mediaType })
  }
}

async function appendWorkspaceFile(workspace: Workspace, path: string, content: string) {
  let current = ""
  try {
    current = String(await workspace.readFile(path))
  }
  catch (error) {
    if (!(error instanceof WorkspaceError)) throw error
  }
  await workspace.writeFile(path, `${current}${content}`)
}

function createWriteTools(workspace: Workspace, options: { maxOutputLength: number }, enabled: ReturnType<typeof resolveWriteOperations>): Partial<WorkspaceWriteTools> {
  const result: Partial<WorkspaceWriteTools> = {}

  if (enabled.writeFile) {
    result.writeFile = tool({
      description: "Write a text file to the workspace.",
      inputSchema: jsonSchema<{ content: string, mediaType?: string, path: string }>({
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          mediaType: { type: "string" },
          path: { type: "string" },
        },
        required: ["path", "content"],
        type: "object",
      }),
      execute: async ({ content, mediaType, path }) => {
        const normalized = cleanMutationPath(path, "writeFile")
        await workspace.writeFile(normalized, content, { mediaType } satisfies WriteFileOptions)
        return { path: normalized }
      },
    })
  }

  if (enabled.appendFile) {
    result.appendFile = tool({
      description: "Append text to a workspace file, creating it if it does not exist.",
      inputSchema: jsonSchema<{ content: string, path: string }>({
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          path: { type: "string" },
        },
        required: ["path", "content"],
        type: "object",
      }),
      execute: async ({ content, path }) => {
        const normalized = cleanMutationPath(path, "appendFile")
        await appendWorkspaceFile(workspace, normalized, content)
        return { path: normalized }
      },
    })
  }

  if (enabled.deletePath) {
    result.deletePath = tool({
      description: "Delete a file or directory from the workspace.",
      inputSchema: jsonSchema<{ force?: boolean, path: string, recursive?: boolean }>({
        additionalProperties: false,
        properties: {
          force: { type: "boolean" },
          path: { type: "string" },
          recursive: { type: "boolean" },
        },
        required: ["path"],
        type: "object",
      }),
      execute: async ({ force, path, recursive }) => {
        const normalized = cleanMutationPath(path, "deletePath")
        await workspace.rm(normalized, { force, recursive })
        return { path: normalized }
      },
    })
  }

  if (enabled.makeDir) {
    result.makeDir = tool({
      description: "Create a directory in the workspace.",
      inputSchema: jsonSchema<{ path: string, recursive?: boolean }>({
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean" },
        },
        required: ["path"],
        type: "object",
      }),
      execute: async ({ path, recursive }) => {
        const normalized = cleanMutationPath(path, "makeDir")
        await workspace.mkdir(normalized, { recursive })
        return { path: normalized }
      },
    })
  }

  if (enabled.copyPath) {
    result.copyPath = tool({
      description: "Copy a file or directory inside the workspace.",
      inputSchema: jsonSchema<{ from: string, overwrite?: boolean, to: string }>({
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          overwrite: { type: "boolean" },
          to: { type: "string" },
        },
        required: ["from", "to"],
        type: "object",
      }),
      execute: async ({ from, overwrite = false, to }) => {
        const source = cleanMutationPath(from, "copyPath source")
        const target = cleanMutationPath(to, "copyPath destination")
        await copyWorkspacePath(workspace, source, target, overwrite)
        return { from: source, to: target }
      },
    })
  }

  if (enabled.movePath) {
    result.movePath = tool({
      description: "Move or rename a file or directory inside the workspace.",
      inputSchema: jsonSchema<{ from: string, overwrite?: boolean, to: string }>({
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          overwrite: { type: "boolean" },
          to: { type: "string" },
        },
        required: ["from", "to"],
        type: "object",
      }),
      execute: async ({ from, overwrite = false, to }) => {
        const source = cleanMutationPath(from, "movePath source")
        const target = cleanMutationPath(to, "movePath destination")
        await copyWorkspacePath(workspace, source, target, overwrite)
        await workspace.rm(source, { recursive: true, force: true })
        return { from: source, to: target }
      },
    })
  }

  void options
  return result
}

export function createWorkspaceTools<Operations extends WorkspaceToolOperations | undefined = undefined>(
  input: Workspace | WorkspaceAssets,
  options: WorkspaceToolOptions<Operations> = {},
): WorkspaceTools<Operations> {
  const reader = createReader(input)
  const resolved = {
    cwd: options.cwd || "/workspace",
    maxOutputLength: options.maxOutputLength || defaultMaxOutputLength,
    operations: resolveReadOperations(options.operations),
    write: resolveWriteOperations(options.operations?.write),
  }
  const commands = shellCommandsFor(resolved.operations)
  const writeEnabled = Object.values(resolved.write).some(Boolean)

  if (!commands.size && !writeEnabled) {
    throw new TypeError("[vitehub] createWorkspaceTools requires at least one enabled workspace operation.")
  }

  if (writeEnabled && !isWorkspace(input)) {
    throw new TypeError("[vitehub] Write operations require a mutable Workspace. Use useWorkspace(name, { allowWrite: true }).tools().")
  }

  const result: Record<string, Tool<any, any>> = {}

  if (commands.size) {
    result.shell = tool({
      description: describeShellCommands(commands),
      inputSchema: jsonSchema<{ command: string }>({
        additionalProperties: false,
        properties: {
          command: {
            description: "A single workspace inspection command to run.",
            type: "string",
          },
        },
        required: ["command"],
        type: "object",
      }),
      execute: async ({ command }) => await runShellCommand(reader, command, resolved, commands),
    })
  }

  if (writeEnabled) Object.assign(result, createWriteTools(input as Workspace, resolved, resolved.write))

  return result as WorkspaceTools<Operations>
}
