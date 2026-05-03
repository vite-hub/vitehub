import { jsonSchema, tool, type Tool, type ToolSet } from "ai"

import { appendWorkspaceFile, copyWorkspacePath } from "./fs-ops.ts"
import { normalizeSafeWorkspacePath } from "./path.ts"

import type { Workspace, WorkspaceAssets, WriteFileOptions } from "./types.ts"
import type { WorkspaceEntry, WorkspaceSearchHit, WorkspaceSearchQuery, WorkspaceStat } from "./types.ts"

export interface WorkspacePathResult {
  path: string
}

export interface WorkspaceMoveResult {
  from: string
  to: string
}

export interface WorkspaceReadOperations {
  exists?: boolean
  list?: boolean
  readFile?: boolean
  search?: boolean
  stat?: boolean
}

export interface WorkspaceWriteOperations {
  appendFile?: boolean
  copyPath?: boolean
  deletePath?: boolean
  makeDir?: boolean
  movePath?: boolean
  writeFile?: boolean
}

export type WorkspaceToolOperations = {
  read?: true | WorkspaceReadOperations
  write?: true | WorkspaceWriteOperations
}

export interface WorkspaceToolOptions<Operations extends WorkspaceToolOperations | undefined = undefined> {
  operations?: Operations
}

type ResolvedWriteOperations<Operations> = Operations extends { write: infer Write } ? Write : false
type ResolvedReadOperations<Operations> = Operations extends { read: infer Read } ? Read : true

export type WorkspaceReadToolMap = {
  exists: Tool<{ path: string }, { exists: boolean, path: string }>
  list: Tool<{ path?: string, recursive?: boolean }, { entries: WorkspaceEntry[] }>
  readFile: Tool<{ path: string }, { content: string, path: string }>
  search: Tool<WorkspaceSearchQuery, { hits: WorkspaceSearchHit[] }>
  stat: Tool<{ path: string }, WorkspaceStat>
}

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

type EnabledReadTools<Selection> = Selection extends true
  ? WorkspaceReadToolMap
  : Selection extends WorkspaceReadOperations
    ? {
        [Key in keyof WorkspaceReadToolMap as Key extends keyof Selection
          ? Selection[Key] extends false ? never : Key
          : Key]: WorkspaceReadToolMap[Key]
      }
    : {}

export type WorkspaceTools<Operations = undefined> =
  EnabledReadTools<ResolvedReadOperations<Operations>>
  & EnabledWriteTools<ResolvedWriteOperations<Operations>>
  & ToolSet

function isWorkspace(input: Workspace | WorkspaceAssets): input is Workspace {
  return "sync" in input
}

function cleanMutationPath(path: string) {
  return normalizeSafeWorkspacePath(path)
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

function resolveReadOperations(read: true | WorkspaceReadOperations | undefined) {
  if (read === undefined || read === true) {
    return {
      exists: true,
      list: true,
      readFile: true,
      search: true,
      stat: true,
    }
  }

  return {
    exists: read.exists !== false,
    list: read.list !== false,
    readFile: read.readFile !== false,
    search: read.search !== false,
    stat: read.stat !== false,
  }
}

function textContent(content: string | Uint8Array) {
  return typeof content === "string" ? content : new TextDecoder().decode(content)
}

function createReadTools(input: Workspace | WorkspaceAssets, enabled: ReturnType<typeof resolveReadOperations>): Partial<WorkspaceReadToolMap> {
  const result: Partial<WorkspaceReadToolMap> = {}

  if (enabled.list) {
    result.list = tool({
      description: "List workspace files and directories.",
      inputSchema: jsonSchema<{ path?: string, recursive?: boolean }>({
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean" },
        },
        type: "object",
      }),
      execute: async ({ path = "", recursive = false }) => ({ entries: await input.list(normalizeSafeWorkspacePath(path, { allowEmpty: true }), { recursive }) }),
    })
  }

  if (enabled.readFile) {
    result.readFile = tool({
      description: "Read a workspace file as text.",
      inputSchema: jsonSchema<{ path: string }>({
        additionalProperties: false,
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
        type: "object",
      }),
      execute: async ({ path }) => {
        const normalized = normalizeSafeWorkspacePath(path)
        return {
          content: textContent(await input.readFile(normalized, { encoding: "binary" })),
          path: normalized,
        }
      },
    })
  }

  if (enabled.search) {
    result.search = tool({
      description: "Search workspace files.",
      inputSchema: jsonSchema<WorkspaceSearchQuery>({
        additionalProperties: false,
        properties: {
          caseSensitive: { type: "boolean" },
          cwd: { type: "string" },
          limit: { type: "number" },
          paths: { items: { type: "string" }, type: "array" },
          pattern: { type: "string" },
          regex: { type: "boolean" },
        },
        required: ["pattern"],
        type: "object",
      }),
      execute: async query => ({ hits: await input.search(query) }),
    })
  }

  if (enabled.stat) {
    result.stat = tool({
      description: "Get metadata for a workspace path.",
      inputSchema: jsonSchema<{ path: string }>({
        additionalProperties: false,
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
        type: "object",
      }),
      execute: async ({ path }) => await input.stat(normalizeSafeWorkspacePath(path)),
    })
  }

  if (enabled.exists) {
    result.exists = tool({
      description: "Check whether a workspace path exists.",
      inputSchema: jsonSchema<{ path: string }>({
        additionalProperties: false,
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
        type: "object",
      }),
      execute: async ({ path }) => {
        const normalized = normalizeSafeWorkspacePath(path)
        return { exists: await input.exists(normalized), path: normalized }
      },
    })
  }

  return result
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
  const read = resolveReadOperations(options.operations?.read)
  const write = resolveWriteOperations(options.operations?.write)
  const readEnabled = Object.values(read).some(Boolean)
  const writeEnabled = Object.values(write).some(Boolean)

  if (!readEnabled && !writeEnabled) {
    throw new TypeError("[vitehub] createWorkspaceTools requires at least one enabled workspace operation.")
  }

  if (writeEnabled && !isWorkspace(input)) {
    throw new TypeError("[vitehub] Write operations require a mutable Workspace. Use useWorkspace(name, { allowWrite: true }).tools().")
  }

  return {
    ...createReadTools(input, read),
    ...(writeEnabled ? createWriteTools(input as Workspace, write) : {}),
  } as WorkspaceTools<Operations>
}
