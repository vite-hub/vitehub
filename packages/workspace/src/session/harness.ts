import { posix } from "node:path"
import { gzipSync } from "node:zlib"
import { lookup } from "mrmime"

import { contentToBytes, normalizeSafeWorkspacePath } from "../core/path.ts"
import { resolveWorkspaceAutoCommit } from "../core/rules.ts"
import type {
  ReadonlyWorkspaceFacade,
  WritableWorkspaceFacade,
} from "../core/use.ts"
import { isMissingWorkspacePathError } from "./scope.ts"
import type {
  MkdirOptions,
  WorkspaceDefinition,
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
  definition?: WorkspaceDefinition
  ignoreWriteBackPaths?: readonly string[]
  paths?: readonly string[]
  session: HarnessSandboxSession
  sessionWorkDir: string
}

type WorkspaceFacade = ReadonlyWorkspaceFacade | WritableWorkspaceFacade
type InitialFile = { content: Uint8Array, mediaType?: string, symlinkTarget?: string }
type InitialTree = {
  archiveDirectories: Set<string>
  directories: Set<string>
  files: Map<string, InitialFile>
}
type SourceMaterializer = (options?: { path?: string }) => Promise<unknown>
type WorkspaceFsWithSources = { materializeSources?: SourceMaterializer }
const archivePath = ".vitehub-workspace.tar.gz"
const tarBlockSize = 512
const workspaceReadConcurrency = 16

function isWritableWorkspaceFacade(workspace: WorkspaceFacade): workspace is WritableWorkspaceFacade {
  return "startSession" in workspace && typeof workspace.startSession === "function"
}

function workspaceSourceMaterializer(workspace: WorkspaceFacade): SourceMaterializer | undefined {
  if ("materializeSources" in workspace && typeof workspace.materializeSources === "function") {
    return options => workspace.materializeSources(options)
  }

  const materializeSources = (workspace.fs as WorkspaceFsWithSources).materializeSources
  if (typeof materializeSources === "function") {
    return options => materializeSources(options)
  }
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
  if (paths === undefined) return undefined
  const normalized = [...new Set((paths || []).map(normalizeHarnessWorkspacePath))]
  if (normalized.includes("")) return undefined
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

async function forEachConcurrent<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let index = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++]
      if (item !== undefined) await fn(item)
    }
  }))
}

async function workspaceEntries(workspace: WorkspaceFacade, paths: string[] | undefined) {
  if (paths && !paths.length) return []
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

async function materializeWorkspaceSourcesForSession(workspace: WorkspaceFacade, paths: string[] | undefined) {
  const materialize = workspaceSourceMaterializer(workspace)
  if (!materialize) return

  if (paths && !paths.length) return
  await Promise.all((paths || [""]).map(async (path) => {
    await materialize({ path }).catch((error) => {
      if (path && isMissingWorkspacePathError(error)) return
      throw error
    })
  }))
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
  const workDir = posix.normalize(sessionWorkDir)
  const parent = posix.dirname(workDir)
  const name = posix.basename(workDir)
  await sandbox.writeBinaryFile({
    abortSignal,
    content: new Uint8Array(),
    path: sandboxPath(parent, ".vitehub-reset"),
  })
  await runSandbox(sandbox, {
    abortSignal,
    command: `rm -rf -- ${shellQuote(name)} && mkdir -p -- ${shellQuote(name)} && rm -f -- ${shellQuote(".vitehub-reset")}`,
    workingDirectory: parent,
  })
}

function paddedTarContent(content: Uint8Array) {
  const padding = content.byteLength % tarBlockSize
    ? tarBlockSize - (content.byteLength % tarBlockSize)
    : 0
  if (!padding) return Buffer.from(content)
  return Buffer.concat([Buffer.from(content), Buffer.alloc(padding)])
}

function splitTarPath(path: string): { name: string, prefix?: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path }
  const parts = path.split("/")
  for (let index = 1; index < parts.length; index++) {
    const prefix = parts.slice(0, index).join("/")
    const name = parts.slice(index).join("/")
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100)
      return { name, prefix }
  }
  throw new Error(`[vitehub] Harness Workspace Session path is too long for tar transfer: ${path}`)
}

function writeTarString(header: Buffer, offset: number, length: number, value: string) {
  const bytes = Buffer.from(value)
  bytes.copy(header, offset, 0, Math.min(bytes.byteLength, length))
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number) {
  const text = value.toString(8).padStart(length - 1, "0").slice(-(length - 1))
  header.write(text, offset, length - 1, "ascii")
  header[offset + length - 1] = 0
}

function tarHeader(path: string, options: { linkName?: string, mode: number, size: number, type: "directory" | "file" | "symlink" }) {
  const header = Buffer.alloc(tarBlockSize)
  const { name, prefix } = splitTarPath(path)
  if (options.linkName && Buffer.byteLength(options.linkName) > 100)
    throw new Error(`[vitehub] Harness Workspace Session symlink target is too long for tar transfer: ${path}`)
  writeTarString(header, 0, 100, name)
  writeTarOctal(header, 100, 8, options.mode)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, options.size)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = options.type === "directory" ? 0x35 : options.type === "symlink" ? 0x32 : 0x30
  if (options.linkName) writeTarString(header, 157, 100, options.linkName)
  writeTarString(header, 257, 6, "ustar")
  writeTarString(header, 263, 2, "00")
  if (prefix) writeTarString(header, 345, 155, prefix)
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii")
  header[154] = 0
  header[155] = 0x20
  return header
}

function createWorkspaceTarGz(directories: Iterable<string>, files: Map<string, InitialFile>) {
  const blocks: Buffer[] = []
  for (const directory of [...directories].sort((left, right) => left.localeCompare(right))) {
    const path = directory.endsWith("/") ? directory : `${directory}/`
    blocks.push(tarHeader(path, { mode: 0o755, size: 0, type: "directory" }))
  }
  for (const [path, file] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (file.symlinkTarget) {
      blocks.push(tarHeader(path, { linkName: file.symlinkTarget, mode: 0o777, size: 0, type: "symlink" }))
      continue
    }
    blocks.push(tarHeader(path, { mode: 0o644, size: file.content.byteLength, type: "file" }))
    blocks.push(paddedTarContent(file.content))
  }
  blocks.push(Buffer.alloc(tarBlockSize * 2))
  return gzipSync(Buffer.concat(blocks))
}

function gitSymlinkTarget(entry: WorkspaceEntry, content: Uint8Array): string | undefined {
  return entry.metadata?.gitMode === "120000" ? new TextDecoder().decode(content) : undefined
}

async function extractWorkspaceArchive(
  sandbox: HarnessSandboxSession,
  sessionWorkDir: string,
  initialTree: InitialTree,
  directories: Set<string>,
  abortSignal: AbortSignal | undefined,
) {
  if (!initialTree.files.size && !directories.size) return
  const path = sandboxPath(sessionWorkDir, archivePath)
  await sandbox.writeBinaryFile({
    abortSignal,
    content: createWorkspaceTarGz(directories, initialTree.files),
    path,
  })
  await runSandbox(sandbox, {
    abortSignal,
    command: `tar -xzf ${shellQuote(archivePath)} && rm ${shellQuote(archivePath)}`,
    workingDirectory: sessionWorkDir,
  })
}

async function listSandboxPaths(
  sandbox: HarnessSandboxSession,
  sessionWorkDir: string,
  type: "d" | "f" | "l",
  abortSignal: AbortSignal | undefined,
) {
  const result = await runSandbox(sandbox, {
    abortSignal,
    command: `find . -type ${type} -print`,
    workingDirectory: sessionWorkDir,
  })
  return new Set(pathsFromFindOutput(result.stdout))
}

async function readSandboxSymlinkTarget(
  sandbox: HarnessSandboxSession,
  sessionWorkDir: string,
  path: string,
  abortSignal: AbortSignal | undefined,
) {
  const result = await runSandbox(sandbox, {
    abortSignal,
    command: `readlink -- ${shellQuote(path)}`,
    workingDirectory: sessionWorkDir,
  })
  return result.stdout.replace(/\n$/, "")
}

async function copyWorkspaceToSandbox(
  workspace: WorkspaceFacade,
  sandbox: HarnessSandboxSession,
  sessionWorkDir: string,
  abortSignal: AbortSignal | undefined,
  paths: string[] | undefined,
) {
  await materializeWorkspaceSourcesForSession(workspace, paths)
  const entries = await workspaceEntries(workspace, paths)
  const directoriesToCreate = new Set(workspaceDirectories(entries))
  const initialTree: InitialTree = {
    archiveDirectories: directoriesToCreate,
    directories: new Set(workspaceDirectories(entries)),
    files: new Map(),
  }
  const files = workspaceFiles(entries)
  for (const entry of files) addParentDirectories(directoriesToCreate, entry.path)
  await forEachConcurrent(files, workspaceReadConcurrency, async (entry) => {
    const content = await workspace.fs.readFile(entry.path, { encoding: "binary" })
    const bytes = contentToBytes(content)
    initialTree.files.set(entry.path, { content: bytes, mediaType: entry.mediaType, symlinkTarget: gitSymlinkTarget(entry, bytes) })
  })
  await resetSandboxWorkDir(sandbox, sessionWorkDir, abortSignal)
  await extractWorkspaceArchive(sandbox, sessionWorkDir, initialTree, directoriesToCreate, abortSignal)
  return initialTree
}

async function copySandboxChangesToWorkspace(
  session: WorkspaceSession,
  definition: WorkspaceDefinition | undefined,
  sandbox: HarnessSandboxSession,
  sessionWorkDir: string,
  initialTree: InitialTree,
  abortSignal: AbortSignal | undefined,
  ignoreWriteBackPaths: Set<string>,
) {
  if (!sandbox.readBinaryFile) {
    throw new Error("[vitehub] Harness Workspace Session write mode requires sandbox.readBinaryFile.")
  }

  const sandboxDirectories = await listSandboxPaths(sandbox, sessionWorkDir, "d", abortSignal)
  const sandboxFiles = await listSandboxPaths(sandbox, sessionWorkDir, "f", abortSignal)
  const sandboxSymlinks = await listSandboxPaths(sandbox, sessionWorkDir, "l", abortSignal)
  const sandboxFileEntries = new Set([...sandboxFiles, ...sandboxSymlinks])
  for (const path of initialTree.files.keys()) {
    if (ignoreWriteBackPaths.has(path)) continue
    if (!sandboxFileEntries.has(path)) await session.rm(path, { force: true })
  }
  for (const path of [...initialTree.directories].sort((left, right) => right.length - left.length)) {
    if (!sandboxDirectories.has(path)) await session.rm(path, { force: true, recursive: true })
  }
  for (const path of sandboxDirectories) {
    if (initialTree.archiveDirectories.has(path)) continue
    await session.mkdir(path, { recursive: true } satisfies MkdirOptions)
  }
  for (const path of sandboxFiles) {
    if (ignoreWriteBackPaths.has(path)) continue
    const initial = initialTree.files.get(path)
    const content = await sandbox.readBinaryFile({
      abortSignal,
      path: sandboxPath(sessionWorkDir, path),
    })
    if (!content || (!initial?.symlinkTarget && bytesEqual(initial?.content, content))) continue
    await session.writeFile(path, content, {
      mediaType: initial?.mediaType || lookup(path) || undefined,
    })
  }
  for (const path of sandboxSymlinks) {
    if (ignoreWriteBackPaths.has(path)) continue
    const initial = initialTree.files.get(path)
    const target = await readSandboxSymlinkTarget(sandbox, sessionWorkDir, path, abortSignal)
    if (initial?.symlinkTarget === target) continue
    await session.writeFile(path, contentToBytes(target), {
      metadata: { gitMode: "120000" },
    })
  }

  const diff = await session.diff()
  if (!diff.entries.length) return
  const commit = definition ? resolveWorkspaceAutoCommit(definition, diff) : undefined
  if (definition && !commit) return
  await session.commit({ message: commit?.message || "harness-workspace-session" })
}

export async function prepareHarnessWorkspaceSession(
  workspace: WorkspaceFacade,
  options: PrepareHarnessWorkspaceSessionOptions,
): Promise<HarnessWorkspaceSession> {
  const paths = normalizeSessionPaths(options.paths)
  const ignoreWriteBackPaths = new Set((options.ignoreWriteBackPaths || []).map(normalizeHarnessWorkspacePath))
  const initialTree = await copyWorkspaceToSandbox(workspace, options.session, options.sessionWorkDir, options.abortSignal, paths)
  const sessionOptions: WorkspaceSessionOptions | undefined = paths ? { paths } : undefined
  const workspaceSession = isWritableWorkspaceFacade(workspace) && (paths === undefined || paths.length)
    ? await workspace.startSession(sessionOptions)
    : undefined

  return {
    async close(error?: unknown) {
      try {
        if (!error && workspaceSession) {
          await copySandboxChangesToWorkspace(
            workspaceSession,
            options.definition,
            options.session,
            options.sessionWorkDir,
            initialTree,
            options.abortSignal,
            ignoreWriteBackPaths,
          )
        }
      }
      finally {
        await workspaceSession?.close()
      }
    },
  }
}
