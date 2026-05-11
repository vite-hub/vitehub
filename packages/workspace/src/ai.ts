import { jsonSchema, tool, type Tool, type ToolSet } from "ai"
import { cleanWorkspaceShellPath, createReadonlyWorkspaceFs, runWorkspaceInspectionCommand } from "@vitehub/shell/workspace"

import { appendWorkspaceFile, copyWorkspacePath } from "./fs-ops.ts"

import type { Workspace, WorkspaceAssets, WriteFileOptions } from "./types.ts"

export interface WorkspaceShellResult {
  exitCode: number
  stderr: string
  stdout: string
}

export interface WorkspaceMaterializeSourcesResult {
  bytes: number
  directories: number
  durationMs: number
  files: number
  limit: number
  path: string
  skipped: number
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
  materialize?: boolean
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
  & (Operations extends { materialize: true }
    ? { materialize_sources: Tool<{ limit?: number, path?: string }, WorkspaceMaterializeSourcesResult> }
    : {})
  ) & ToolSet

const defaultMaxOutputLength = 30_000
const defaultMaterializeLimit = 1_000
const workspaceMountPoint = "/workspace"

function isCloudflareWorkersRuntime() {
  return typeof navigator === "object" && navigator.userAgent === "Cloudflare-Workers"
}

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
    materialize: operations?.materialize === true,
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
  const supported = new Set(commands)
  const available = [
    supported.has("pwd") && "`pwd`",
    supported.has("ls") && "`ls`",
    supported.has("find") && "`find`",
    (supported.has("rg") || supported.has("grep")) && "`rg [-i] pattern [path...]`, `grep -ri pattern [path...]`",
    supported.has("cat") && "`cat`",
    supported.has("head") && "`head`",
    supported.has("tail") && "`tail`",
    supported.has("wc") && "`wc`",
  ].filter(Boolean)

  return [
    "Run a real Bash-compatible workspace shell command over files mounted at `/workspace`.",
    `Available workspace commands include: ${available.join(", ")}.`,
    "Pipes, redirects, chaining, quoted patterns, and multiline shell scripts are supported by the shell runtime.",
    "The workspace filesystem controls whether writes are allowed; read-only tools reject mutation commands at execution time.",
    "Do not use shell commands such as `echo` to compose assistant replies; answer conversational messages directly.",
    "Examples: `rg 'siff|PLC' ingestion forecasting-engine | head -n 20`; `find ingestion -type f -name '*.sql'`; `cat forecasting-engine/README.md | head -n 40`.",
  ].join(" ")
}

async function runShellCommand(
  input: Workspace | WorkspaceAssets,
  command: string,
  options: { commands: string[], cwd: string, maxOutputLength: number },
): Promise<WorkspaceShellResult> {
  return await runWorkspaceInspectionCommand(input, command, {
    commands: options.commands,
    cwd: options.cwd,
    fs: createReadonlyWorkspaceFs(input),
    maxOutputLength: options.maxOutputLength,
    provider: isCloudflareWorkersRuntime() ? "cloudflare-shell" : "just-bash",
  }) as WorkspaceShellResult
}

function sizeOf(content: string | Uint8Array) {
  return typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength
}

async function materializeWorkspaceSources(
  input: Workspace | WorkspaceAssets,
  options: { limit?: number, path?: string },
): Promise<WorkspaceMaterializeSourcesResult> {
  const started = Date.now()
  const path = cleanWorkspaceShellPath(options.path || "") || ""
  const limit = Math.max(1, Math.min(options.limit || defaultMaterializeLimit, 10_000))
  const entries = await input.list(path, { recursive: true })
  let bytes = 0
  let directories = 0
  let files = 0

  for (const entry of entries) {
    if (entry.type === "directory") {
      directories++
      continue
    }
    if (files >= limit) continue
    const content = await input.readFile(entry.path, { encoding: "binary" })
    bytes += sizeOf(content)
    files++
  }

  return {
    bytes,
    directories,
    durationMs: Date.now() - started,
    files,
    limit,
    path,
    skipped: Math.max(0, entries.filter(entry => entry.type === "file").length - files),
  }
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
    materialize: resolveReadOperations(options.operations).materialize,
    maxOutputLength: options.maxOutputLength || defaultMaxOutputLength,
    write: resolveWriteOperations(options.operations?.write),
  }
  const writeEnabled = Object.values(resolved.write).some(Boolean)

  if (!resolved.commands.length && !resolved.materialize && !writeEnabled) {
    throw new TypeError("[vitehub] createWorkspaceTools requires at least one enabled workspace operation.")
  }

  if (writeEnabled && !isWorkspace(input)) {
    throw new TypeError("[vitehub] Write operations require a mutable Workspace. Use useWorkspace(name, { allowWrite: true }).tools.write().")
  }

  const result: Record<string, Tool<any, any>> = {}

  if (resolved.commands.length) {
    result.shell = tool({
      description: describeShellCommands(resolved.commands),
      inputSchema: jsonSchema<{ command: string }>({
        additionalProperties: false,
        properties: {
          command: {
            description: "A Bash-compatible workspace shell command. Use pipes, redirects, chaining, and quoted patterns as needed.",
            type: "string",
          },
        },
        required: ["command"],
        type: "object",
      }),
      execute: async ({ command }) => await runShellCommand(input, command, resolved),
    })
  }

  if (resolved.materialize) {
    result.materialize_sources = tool({
      description: [
        "Materialize lazy workspace source files as an explicit tool step before shell inspection.",
        "Use this when the first workspace read would otherwise hide source preparation inside another tool call.",
      ].join(" "),
      inputSchema: jsonSchema<{ limit?: number, path?: string }>({
        additionalProperties: false,
        properties: {
          limit: {
            description: "Maximum number of files to materialize. Defaults to 1000.",
            minimum: 1,
            type: "number",
          },
          path: {
            description: "Workspace path prefix to materialize. Defaults to the workspace root.",
            type: "string",
          },
        },
        type: "object",
      }),
      execute: async ({ limit, path }) => await materializeWorkspaceSources(input, { limit, path }),
    })
  }

  if (writeEnabled) Object.assign(result, createWriteTools(input as Workspace, resolved.write))

  return result as WorkspaceTools<Operations>
}
