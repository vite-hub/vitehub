import { appendWorkspaceFile, copyWorkspacePath } from "./fs-ops.ts"
import { normalizeSafeWorkspacePath } from "./path.ts"

import type { Tool, ToolSet } from "ai"
import type { Workspace, WorkspaceAssets, WriteFileOptions } from "./types.ts"

const aiSchemaSymbol = Symbol.for("vercel.ai.schema")

function jsonSchema<T>(schema: unknown): Tool<T, unknown>["inputSchema"] {
  return {
    _type: undefined as T | undefined,
    get jsonSchema() {
      return schema
    },
    validate: undefined,
    [aiSchemaSymbol]: true,
  } as unknown as Tool<T, unknown>["inputSchema"]
}

function tool<INPUT, OUTPUT>(definition: Tool<INPUT, OUTPUT>): Tool<INPUT, OUTPUT> {
  return definition
}

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

export type EnabledReadCapability<Operations, Key extends keyof WorkspaceReadOperations> = Operations extends Record<Key, infer Value>
  ? Value extends false ? false : true
  : true

export type ShellEnabled<Operations> = true extends
  | EnabledReadCapability<Operations, "list">
  | EnabledReadCapability<Operations, "read">
  | EnabledReadCapability<Operations, "search">
  ? true
  : false

type ResolvedWriteOperations<Operations> = Operations extends { write: infer Write } ? Write : false

export type WorkspaceWriteToolMap = {
  appendFile: Tool<{ content: string, path: string }, WorkspacePathResult>
  copyPath: Tool<{ from: string, overwrite?: boolean, to: string }, WorkspaceMoveResult>
  deletePath: Tool<{ force?: boolean, path: string, recursive?: boolean }, WorkspacePathResult>
  makeDir: Tool<{ path: string, recursive?: boolean }, WorkspacePathResult>
  movePath: Tool<{ from: string, overwrite?: boolean, to: string }, WorkspaceMoveResult>
  writeFile: Tool<{ content: string, mediaType?: string, path: string }, WorkspacePathResult>
}

type EnabledWriteTools<Selection> = Selection extends true
  ? WorkspaceWriteToolMap
  : Selection extends WorkspaceWriteOperations
    ? {
        [Key in keyof WorkspaceWriteToolMap as Key extends keyof Selection
          ? Selection[Key] extends true ? Key : never
          : never]: WorkspaceWriteToolMap[Key]
      }
    : {}

export type WorkspaceTools<Operations = undefined> = ((ShellEnabled<Operations> extends true
  ? { shell: Tool<{ command: string }, WorkspaceShellResult> }
  : {}) & EnabledWriteTools<ResolvedWriteOperations<Operations>>
  ) & ToolSet

const defaultMaxOutputLength = 30_000
const workspaceMountPoint = "/workspace"

function isWorkspace(input: Workspace | WorkspaceAssets): input is Workspace {
  return "sync" in input
}

function cleanMutationPath(path: string) {
  const normalized = cleanWorkspaceShellPath(path)
  if (!normalized) throw new Error("[vitehub] Workspace root is not a valid mutation target.")
  return normalized
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
  const commands: string[] = []
  if (operations.list) commands.push("pwd", "ls", "find")
  if (operations.read) commands.push("cat", "head", "tail", "wc")
  if (operations.search) commands.push("grep", "rg")
  return commands
}

function describeShellCommands(commands: string[]) {
  return `Run a workspace inspection command in the shell runtime. Supported commands: ${[...commands].sort().join(", ")}.`
}

function applyOutputLimit(output: string, max: number) {
  if (output.length <= max) return output
  return `${output.slice(0, max)}\n[output truncated to ${max} characters]\n`
}

function parseShellCommand(command: string): string[] {
  const words: string[] = []
  let current = ""
  let quote: "\"" | "'" | undefined

  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "\"" || char === "'") {
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

  if (quote) throw new Error("Unsupported shell syntax: unterminated quote.")
  if (current) words.push(current)
  return words
}

function validateSingleCommand(words: string[]) {
  if (words.some(word => /[|;&<>`$()]/.test(word))) {
    throw new Error("Unsupported shell syntax: only a single workspace command is supported.")
  }
}

function cleanWorkspaceShellPath(path = "."): string {
  let normalized = path.trim() || "."
  if (normalized === "." || normalized === "./" || normalized === "/" || normalized === workspaceMountPoint) return ""
  normalized = normalized.replace(/^\/workspace\/?/, "")
  return normalizeSafeWorkspacePath(normalized, { allowEmpty: true })
}

function normalizeCwd(cwd: string) {
  return cleanWorkspaceShellPath(cwd)
}

function resolveShellPath(path: string | undefined, cwd: string) {
  const input = path || "."
  if (input === "." || input === "./") return cwd
  if (input.startsWith("/workspace/")) return cleanWorkspaceShellPath(input)
  if (input.startsWith("/")) throw new Error(`[vitehub] Workspace path escapes the workspace root: "${input}".`)
  return normalizeSafeWorkspacePath(cwd ? `${cwd}/${input}` : input, { allowEmpty: true })
}

function displayPath(path: string, cwd: string) {
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

async function readText(input: Workspace | WorkspaceAssets, path: string) {
  return await input.readFile(path as never)
}

async function listEntries(input: Workspace | WorkspaceAssets, path: string, recursive = false) {
  return await input.list(path as never, { recursive })
}

function formatList(entries: Awaited<ReturnType<typeof listEntries>>, prefix: string) {
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

function lineCount(text: string) {
  if (!text) return 0
  return text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length
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

function parseCountOption(args: string[]) {
  if (args[0] === "-n") {
    const count = Number.parseInt(args[1] || "", 10)
    if (!Number.isFinite(count) || count < 0) throw new Error("[vitehub] Invalid line count.")
    return { count, rest: args.slice(2) }
  }
  return { count: 10, rest: args }
}

async function runFindCommand(input: Workspace | WorkspaceAssets, args: string[], cwd: string) {
  const root = resolveShellPath(args[0] && !args[0].startsWith("-") ? args[0] : ".", cwd)
  const nameIndex = args.indexOf("-name")
  const pattern = nameIndex >= 0 ? args[nameIndex + 1] : undefined
  const matcher = pattern ? globPatternToRegExp(pattern) : undefined
  const entries = await listEntries(input, root, true)
  const lines = entries
    .filter(entry => !matcher || matcher.test(entry.path.split("/").at(-1) || entry.path))
    .map(entry => displayPath(entry.path, cwd))
    .sort((left, right) => left.localeCompare(right))
  return `${lines.join("\n")}${lines.length ? "\n" : ""}`
}

function parseSearchArgs(args: string[], cwd: string) {
  let caseSensitive = true
  let pattern: string | undefined
  const paths: string[] = []

  for (let index = 0; index < args.length; index++) {
    const word = args[index]
    if (word === "-i" || word === "--ignore-case") {
      caseSensitive = false
      continue
    }
    if (word === "-n" || word === "--line-number") continue
    if (word === "-e" || word === "--regexp") {
      pattern = args[index + 1]
      index += 1
      continue
    }
    if (word.startsWith("-")) throw new Error(`[vitehub] Unsupported workspace search flag: ${word}.`)
    if (!pattern) {
      pattern = word
      continue
    }
    paths.push(resolveShellPath(word, cwd))
  }

  if (!pattern) throw new Error("[vitehub] Workspace search commands require a pattern.")
  return { caseSensitive, paths, pattern }
}

async function runSearchCommand(input: Workspace | WorkspaceAssets, args: string[], cwd: string) {
  const query = parseSearchArgs(args, cwd)
  const hits = await input.search({
    caseSensitive: query.caseSensitive,
    cwd,
    limit: 200,
    paths: query.paths,
    pattern: query.pattern,
    regex: true,
  })
  return {
    exitCode: hits.length ? 0 : 1,
    stdout: hits.map(hit => `${hit.path}:${hit.line}:${hit.text}`).join("\n") + (hits.length ? "\n" : ""),
  }
}

async function runWorkspaceInspectionCommand(
  input: Workspace | WorkspaceAssets,
  command: string,
  options: { commands: string[], cwd: string, maxOutputLength: number },
): Promise<WorkspaceShellResult> {
  try {
    const words = parseShellCommand(command)
    validateSingleCommand(words)
    const [name, ...args] = words
    if (!name) return { exitCode: 0, stderr: "", stdout: "" }
    if (!options.commands.includes(name)) {
      return {
        exitCode: 126,
        stderr: applyOutputLimit(`Unsupported workspace shell command: ${name}\n`, options.maxOutputLength),
        stdout: "",
      }
    }

    const cwd = normalizeCwd(options.cwd)
    let stdout = ""
    let exitCode = 0

    if (name === "pwd") {
      stdout = `${workspaceMountPoint}${cwd ? `/${cwd}` : ""}\n`
    }
    else if (name === "ls") {
      const path = resolveShellPath(args.find(arg => !arg.startsWith("-")), cwd)
      stdout = formatList(await listEntries(input, path, false), path)
    }
    else if (name === "find") {
      stdout = await runFindCommand(input, args, cwd)
    }
    else if (name === "cat") {
      stdout = (await Promise.all(args.map(path => readText(input, resolveShellPath(path, cwd))))).join("")
    }
    else if (name === "head") {
      const { count, rest } = parseCountOption(args)
      stdout = firstLines(await readText(input, resolveShellPath(rest[0], cwd)), count)
    }
    else if (name === "tail") {
      const { count, rest } = parseCountOption(args)
      stdout = lastLines(await readText(input, resolveShellPath(rest[0], cwd)), count)
    }
    else if (name === "wc" && args[0] === "-l") {
      const path = resolveShellPath(args[1], cwd)
      stdout = `${lineCount(await readText(input, path))} ${args[1]}\n`
    }
    else if (name === "grep" || name === "rg") {
      const result = await runSearchCommand(input, args, cwd)
      exitCode = result.exitCode
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
      stdout: applyOutputLimit(stdout, options.maxOutputLength),
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

async function runShellCommand(
  input: Workspace | WorkspaceAssets,
  command: string,
  options: { commands: string[], cwd: string, maxOutputLength: number },
): Promise<WorkspaceShellResult> {
  return await runWorkspaceInspectionCommand(input, command, options)
}

function createWriteTools(workspace: Workspace, enabled: ReturnType<typeof resolveWriteOperations>): Partial<WorkspaceWriteToolMap> {
  const result: Partial<WorkspaceWriteToolMap> = {}

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
        const normalized = cleanMutationPath(path)
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
        const normalized = cleanMutationPath(path)
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
        const normalized = cleanMutationPath(path)
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
        const normalized = cleanMutationPath(path)
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
        const source = cleanMutationPath(from)
        const target = cleanMutationPath(to)
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
        const source = cleanMutationPath(from)
        const target = cleanMutationPath(to)
        await copyWorkspacePath(workspace, source, target, overwrite)
        await workspace.rm(source, { recursive: true, force: true })
        return { from: source, to: target }
      },
    })
  }

  return result
}

export function createWorkspaceTools<Operations extends WorkspaceToolOperations | undefined = undefined>(
  input: Workspace | WorkspaceAssets,
  options: WorkspaceToolOptions<Operations> = {},
): WorkspaceTools<Operations> {
  const resolved = {
    commands: shellCommandsFor(resolveReadOperations(options.operations)),
    cwd: options.cwd || workspaceMountPoint,
    maxOutputLength: options.maxOutputLength || defaultMaxOutputLength,
    write: resolveWriteOperations(options.operations?.write),
  }
  const writeEnabled = Object.values(resolved.write).some(Boolean)

  if (!resolved.commands.length && !writeEnabled) {
    throw new TypeError("[vitehub] createWorkspaceTools requires at least one enabled workspace operation.")
  }

  if (writeEnabled && !isWorkspace(input)) {
    throw new TypeError("[vitehub] Write operations require a mutable Workspace. Use useWorkspace(name, { allowWrite: true }).tools().")
  }

  const result: Record<string, Tool<any, any>> = {}

  if (resolved.commands.length) {
    result.shell = tool({
      description: describeShellCommands(resolved.commands),
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
      execute: async ({ command }) => await runShellCommand(input, command, resolved),
    })
  }

  if (writeEnabled) Object.assign(result, createWriteTools(input as Workspace, resolved.write))

  return result as WorkspaceTools<Operations>
}
