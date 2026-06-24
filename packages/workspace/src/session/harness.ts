import { posix } from "node:path"
import { lookup } from "mrmime"

import { normalizeSafeWorkspacePath } from "../core/path.ts"
import type {
  ReadonlyWorkspaceFacade,
  WritableWorkspaceFacade,
} from "../core/use.ts"
import type {
  MkdirOptions,
  WorkspaceEntry,
  WorkspaceSession,
  WorkspaceSessionOptions,
} from "../core/types.ts"

export interface HarnessSandboxSession {
  readBinaryFile?(options: { abortSignal?: AbortSignal, path: string }): PromiseLike<Uint8Array | null>
  run(options: { abortSignal?: AbortSignal, command: string, workingDirectory?: string }): PromiseLike<{ exitCode: number, stderr: string, stdout: string }>
  writeBinaryFile(options: { abortSignal?: AbortSignal, content: Uint8Array, path: string }): PromiseLike<void>
}

export interface HarnessWorkspaceSession {
  close(error?: unknown): Promise<void>
}

export interface PrepareHarnessWorkspaceSessionOptions {
  abortSignal?: AbortSignal
  paths?: readonly string[]
  session: HarnessSandboxSession
  sessionWorkDir: string
}

type WorkspaceFacade = ReadonlyWorkspaceFacade | WritableWorkspaceFacade
type InitialFile = { content: Uint8Array, mediaType?: string }
type InitialTree = {
  directories: Set<string>
  files: Map<string, InitialFile>
}

function isWritableWorkspaceFacade(workspace: WorkspaceFacade): workspace is WritableWorkspaceFacade {
  return "startSession" in workspace && typeof workspace.startSession === "function"
}

function sandboxPath(root: string, path: string) {
  return posix.join(root, path)
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function isGeneratedSourceDescriptorPath(path: string): boolean {
  return path === ".vitehub" || path === ".vitehub/sources" || /^\.vitehub\/sources\/[^/]+\.json$/.test(path)
}

function normalizeHarnessWorkspacePath(path = "") {
  const descriptorPath = normalizeSafeWorkspacePath(path, { allowEmpty: true, allowReserved: true })
  if (isGeneratedSourceDescriptorPath(descriptorPath)) return descriptorPath
  return normalizeSafeWorkspacePath(path, { allowEmpty: true })
}

function normalizeSessionPaths(paths?: readonly string[]): string[] | undefined {
  const normalized = [...new Set((paths || []).map(normalizeHarnessWorkspacePath))]
  if (!normalized.length || normalized.includes("")) return undefined
  return normalized.sort((left, right) => left.length - right.length || left.localeCompare(right))
}

async function runSandbox(
  sandbox: HarnessSandboxSession,
  options: { abortSignal?: AbortSignal, command: string, workingDirectory?: string },
) {
  const result = await sandbox.run(options)
  if (result.exitCode !== 0) {
    throw new Error(`[vitehub] Failed to prepare Harness Workspace Session: ${result.stderr || "sandbox command failed"}`)
  }
  return result
}

function workspaceFiles(entries: WorkspaceEntry[]) {
  return entries
    .filter(entry => entry.type === "file")
    .sort((left, right) => left.path.localeCompare(right.path))
}

function workspaceDirectories(entries: WorkspaceEntry[]) {
  return entries
    .filter(entry => entry.type === "directory")
    .map(entry => entry.path)
    .sort((left, right) => left.localeCompare(right))
}

function addParentDirectories(directories: Set<string>, path: string) {
  let directory = posix.dirname(path)
  while (directory && directory !== ".") {
    directories.add(directory)
    directory = posix.dirname(directory)
  }
}

async function workspaceEntries(workspace: WorkspaceFacade, paths: string[] | undefined) {
  if (!paths) return await workspace.fs.list("", { recursive: true })

  const entries = new Map<string, WorkspaceEntry>()
  for (const path of paths) {
    const stat = await workspace.fs.stat(path).catch(() => undefined)
    if (!stat) continue
    entries.set(stat.path, stat)
    if (stat.type === "directory") {
      for (const entry of await workspace.fs.list(path, { recursive: true })) entries.set(entry.path, entry)
    }
  }
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array) {
  if (!left || left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function pathsFromFindOutput(stdout: string) {
  return stdout
    .split("\n")
    .map(path => path.trim())
    .filter(Boolean)
    .map(path => path.replace(/^\.\//, ""))
    .filter(path => path && path !== ".")
    .sort((left, right) => left.localeCompare(right))
}

async function resetSandboxWorkDir(
  sandbox: HarnessSandboxSession,
  sessionWorkDir: string,
  abortSignal: AbortSignal | undefined,
) {
  await runSandbox(sandbox, {
    abortSignal,
    command: `rm -rf ${shellQuote(sessionWorkDir)} && mkdir -p ${shellQuote(sessionWorkDir)}`,
  })
}

async function mkdirSandboxDirectories(
  sandbox: HarnessSandboxSession,
  directories: string[],
  sessionWorkDir: string,
  abortSignal: AbortSignal | undefined,
) {
  if (!directories.length) return
  await runSandbox(sandbox, {
    abortSignal,
    command: `mkdir -p ${directories.map(path => shellQuote(sandboxPath(sessionWorkDir, path))).join(" ")}`,
  })
}

async function listSandboxPaths(
  sandbox: HarnessSandboxSession,
  sessionWorkDir: string,
  type: "d" | "f",
  abortSignal: AbortSignal | undefined,
) {
  const result = await runSandbox(sandbox, {
    abortSignal,
    command: `find . -type ${type} -print`,
    workingDirectory: sessionWorkDir,
  })
  return new Set(pathsFromFindOutput(result.stdout))
}

async function copyWorkspaceToSandbox(
  workspace: WorkspaceFacade,
  sandbox: HarnessSandboxSession,
  sessionWorkDir: string,
  abortSignal: AbortSignal | undefined,
  paths: string[] | undefined,
) {
  const entries = await workspaceEntries(workspace, paths)
  const directoriesToCreate = new Set(workspaceDirectories(entries))
  const initialTree: InitialTree = {
    directories: new Set(workspaceDirectories(entries)),
    files: new Map(),
  }
  for (const entry of workspaceFiles(entries)) addParentDirectories(directoriesToCreate, entry.path)
  await resetSandboxWorkDir(sandbox, sessionWorkDir, abortSignal)
  await mkdirSandboxDirectories(sandbox, [...directoriesToCreate], sessionWorkDir, abortSignal)
  for (const entry of workspaceFiles(entries)) {
    const content = await workspace.fs.readFile(entry.path, { encoding: "binary" })
    initialTree.files.set(entry.path, { content, mediaType: entry.mediaType })
    await sandbox.writeBinaryFile({
      abortSignal,
      content,
      path: sandboxPath(sessionWorkDir, entry.path),
    })
  }
  return initialTree
}

async function copySandboxChangesToWorkspace(
  session: WorkspaceSession,
  sandbox: HarnessSandboxSession,
  sessionWorkDir: string,
  initialTree: InitialTree,
  abortSignal: AbortSignal | undefined,
) {
  if (!sandbox.readBinaryFile) {
    throw new Error("[vitehub] Harness Workspace Session write mode requires sandbox.readBinaryFile.")
  }

  const sandboxDirectories = await listSandboxPaths(sandbox, sessionWorkDir, "d", abortSignal)
  const sandboxFiles = await listSandboxPaths(sandbox, sessionWorkDir, "f", abortSignal)
  for (const path of initialTree.files.keys()) {
    if (!sandboxFiles.has(path)) await session.rm(path, { force: true })
  }
  for (const path of [...initialTree.directories].sort((left, right) => right.length - left.length)) {
    if (!sandboxDirectories.has(path)) await session.rm(path, { force: true, recursive: true })
  }
  for (const path of sandboxDirectories) {
    await session.mkdir(path, { recursive: true } satisfies MkdirOptions)
  }
  for (const path of sandboxFiles) {
    const content = await sandbox.readBinaryFile({
      abortSignal,
      path: sandboxPath(sessionWorkDir, path),
    })
    const initial = initialTree.files.get(path)
    if (!content || bytesEqual(initial?.content, content)) continue
    await session.writeFile(path, content, {
      mediaType: initial?.mediaType || lookup(path) || undefined,
    })
  }

  const diff = await session.diff()
  if (diff.entries.length) await session.commit({ message: "harness-workspace-session" })
}

export async function prepareHarnessWorkspaceSession(
  workspace: WorkspaceFacade,
  options: PrepareHarnessWorkspaceSessionOptions,
): Promise<HarnessWorkspaceSession> {
  const paths = normalizeSessionPaths(options.paths)
  const initialTree = await copyWorkspaceToSandbox(workspace, options.session, options.sessionWorkDir, options.abortSignal, paths)
  const sessionOptions: WorkspaceSessionOptions | undefined = paths ? { paths } : undefined
  const workspaceSession = isWritableWorkspaceFacade(workspace)
    ? await workspace.startSession(sessionOptions)
    : undefined

  return {
    async close(error?: unknown) {
      try {
        if (!error && workspaceSession) {
          await copySandboxChangesToWorkspace(
            workspaceSession,
            options.session,
            options.sessionWorkDir,
            initialTree,
            options.abortSignal,
          )
        }
      }
      finally {
        await workspaceSession?.close()
      }
    },
  }
}
