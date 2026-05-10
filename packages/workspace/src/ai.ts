import { appendWorkspaceFile, copyWorkspacePath } from "./fs-ops.ts"
import { normalizeSafeWorkspacePath } from "./path.ts"
import { createReadonlyWorkspaceFs, runWorkspaceInspectionCommand } from "@vitehub/shell"

import type { Tool, ToolSet } from "ai"
import type { SearchableShellWorkspace } from "@vitehub/shell"
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

function cleanWorkspaceShellPath(path = "."): string {
  let normalized = path.trim() || "."
  if (normalized === "." || normalized === "./" || normalized === "/" || normalized === workspaceMountPoint) return ""
  normalized = normalized.replace(/^\/workspace\/?/, "")
  return normalizeSafeWorkspacePath(normalized, { allowEmpty: true })
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
  return `Run a workspace inspection command in the shell runtime. Supported commands: ${[...commands].sort().join(", ")}. Output can be piped to head or tail for line limiting.`
}

async function runShellCommand(
  input: Workspace | WorkspaceAssets,
  command: string,
  options: { commands: string[], cwd: string, maxOutputLength: number },
): Promise<WorkspaceShellResult> {
  const shellWorkspace = input as unknown as SearchableShellWorkspace
  return await runWorkspaceInspectionCommand(shellWorkspace, command, {
    commands: options.commands,
    cwd: options.cwd,
    fs: createReadonlyWorkspaceFs(shellWorkspace),
    maxOutputLength: options.maxOutputLength,
  }) as WorkspaceShellResult
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
