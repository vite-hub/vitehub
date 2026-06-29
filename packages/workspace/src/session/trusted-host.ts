import { spawn } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, posix, relative, sep } from "node:path"

import { WorkspaceError } from "../core/errors.ts"
import { contentToBytes, decodeFile, matchesAny, normalizeSafeWorkspacePath, normalizeWorkspacePath, resolveInside, sha256 } from "../core/path.ts"
import { createSnapshotFromEntries, diffSnapshots } from "../storage/utils.ts"
import { assertDiffInsideSessionPaths, assertPathInSessionScope, filterSessionDiff, filterSessionEntries, isMissingWorkspacePathError, scopedSearchQuery } from "./scope.ts"

import type {
  ExecOptions,
  ExecResult,
  ReadFileOptions,
  ReadFileResult,
  RmOptions,
  Workspace,
  WorkspaceContent,
  WorkspaceDefinition,
  WorkspaceDiff,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceSearchHit,
  WorkspaceSession,
  WriteFileOptions,
  WorkspaceSessionOptions,
} from "../core/types.ts"

function trustedHostRuntimeAllowsProduction(definition: WorkspaceDefinition) {
  const runtime = definition.runtime
  return typeof runtime === "object"
    && runtime !== null
    && runtime.type === "trusted-host"
    && runtime.allowProduction === true
}

function assertTrustedHostWorkspaceRuntimeAllowed(definition: WorkspaceDefinition) {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  if (env?.NODE_ENV === "production" && !trustedHostRuntimeAllowsProduction(definition)) {
    throw new WorkspaceError("[vitehub] Workspace runtime `trusted-host` is only available outside production. Hosted executable workspaces need `runtime: 'sandbox'`.")
  }
}

function toWorkspacePath(root: string, path: string) {
  return normalizeWorkspacePath(relative(root, path).split(sep).join("/"))
}

function isGeneratedSourceDescriptorPath(path: string): boolean {
  return path === ".vitehub" || path === ".vitehub/sources" || /^\.vitehub\/sources\/[^/]+\.json$/.test(path)
}

function isUncommittedSessionPath(path: string): boolean {
  return isGeneratedSourceDescriptorPath(path) || path.split("/").includes(".git")
}

function normalizeLocalWorkspacePath(path = "", options: { allowEmpty?: boolean, allowGenerated?: boolean } = {}) {
  const normalized = posix.normalize(path.replace(/\\/g, "/"))
  const workspacePath = normalized === "." ? "" : normalized
  const { allowGenerated, ...safeOptions } = options
  if (allowGenerated && isGeneratedSourceDescriptorPath(workspacePath)) {
    return normalizeSafeWorkspacePath(workspacePath, { ...safeOptions, allowReserved: true })
  }
  return normalizeSafeWorkspacePath(workspacePath, safeOptions)
}

function normalizeSessionCwd(path = "") {
  const normalized = path.replace(/\\/g, "/")
  return normalizeLocalWorkspacePath(normalized.replace(/^\/workspace(?:\/|$)/, ""), { allowEmpty: true, allowGenerated: true })
}

function toLocalPath(root: string, path = "", options: { allowGenerated?: boolean } = {}) {
  return resolveInside(root, normalizeLocalWorkspacePath(path, { allowEmpty: true, allowGenerated: options.allowGenerated }))
}

async function listLocalEntries(root: string, path = "", recursive = false, options: { allowGenerated?: boolean, skipUncommitted?: boolean } = {}): Promise<WorkspaceEntry[]> {
  const base = toLocalPath(root, path, options)
  const dirents = await readdir(base, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  })
  const entries: WorkspaceEntry[] = []
  for (const dirent of dirents) {
    const entryPath = join(base, dirent.name)
    const workspacePath = toWorkspacePath(root, entryPath)
    if (options.skipUncommitted && isUncommittedSessionPath(workspacePath)) continue
    if (dirent.isDirectory()) {
      entries.push({ path: workspacePath, type: "directory" })
      if (recursive) entries.push(...await listLocalEntries(root, workspacePath, true, options))
      continue
    }
    if (dirent.isSymbolicLink()) {
      const item = await lstat(entryPath)
      entries.push({ metadata: { gitMode: "120000" }, path: workspacePath, size: item.size, type: "file" })
      continue
    }
    if (!dirent.isFile()) continue
    const item = await stat(entryPath)
    entries.push({ path: workspacePath, size: item.size, type: "file" })
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

function isGitSymlinkEntry(entry: WorkspaceEntry): boolean {
  return entry.metadata?.gitMode === "120000"
}

async function readLocalFile(root: string, path: string, options: { allowGenerated?: boolean, preserveSymlink?: boolean } = {}): Promise<WorkspaceFile | undefined> {
  const target = toLocalPath(root, path, options)
  try {
    if (options.preserveSymlink && (await lstat(target)).isSymbolicLink()) {
      return { content: await readlink(target), metadata: { gitMode: "120000" }, path: normalizeWorkspacePath(path) }
    }
    return { content: await readFile(target), path: normalizeWorkspacePath(path) }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function snapshotLocal(root: string, name?: string) {
  const entries = await listLocalEntries(root, "", true, { allowGenerated: true, skipUncommitted: true })
  const files = await Promise.all(entries.map(async (entry) => {
    if (entry.type !== "file") return entry
    const content = isGitSymlinkEntry(entry)
      ? await readlink(toLocalPath(root, entry.path))
      : await readFile(toLocalPath(root, entry.path))
    return {
      ...entry,
      digest: await sha256(content),
      size: contentToBytes(content).byteLength,
    }
  }))
  return await createSnapshotFromEntries(files, name)
}

function normalizeSessionPaths(options?: WorkspaceSessionOptions): string[] | undefined {
  const paths = [...new Set((options?.paths || []).map(path => normalizeLocalWorkspacePath(path, { allowEmpty: true, allowGenerated: true })))]
  if (!paths.length || paths.includes("")) return undefined
  return paths.sort((left, right) => left.length - right.length || left.localeCompare(right))
}

async function sessionEntries(workspace: Workspace, options?: WorkspaceSessionOptions): Promise<WorkspaceEntry[]> {
  const paths = normalizeSessionPaths(options)
  if (!paths) return await workspace.list("", { recursive: true })

  const entries = new Map<string, WorkspaceEntry>()
  for (const path of paths) {
    const stat = await workspace.stat(path).catch((error) => {
      if (isMissingWorkspacePathError(error)) return undefined
      throw error
    })
    if (!stat) continue
    entries.set(stat.path, stat)
    if (stat.type === "directory") {
      for (const entry of await workspace.list(path, { recursive: true })) entries.set(entry.path, entry)
    }
  }
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path))
}

async function materializeWorkspace(workspace: Workspace, root: string, options?: WorkspaceSessionOptions) {
  const entries = await sessionEntries(workspace, options)
  for (const entry of entries.filter(entry => entry.type === "directory"))
    await mkdir(toLocalPath(root, entry.path, { allowGenerated: true }), { recursive: true })
  for (const entry of entries) {
    if (entry.type !== "file") continue
    const target = toLocalPath(root, entry.path, { allowGenerated: true })
    await mkdir(dirname(target), { recursive: true })
    if (isGitSymlinkEntry(entry)) {
      await symlink(await workspace.readFile(entry.path), target)
      continue
    }
    await writeFile(target, await workspace.readFile(entry.path, { encoding: "binary" }))
  }
  return await snapshotLocal(root, "local-open")
}

async function commitLocalChanges(
  root: string,
  workspace: Workspace,
  diff: WorkspaceDiff,
  mediaTypes: Map<string, string>,
) {
  for (const entry of diff.entries) {
    if (isUncommittedSessionPath(entry.path)) continue
    if (entry.after?.type === "directory") {
      if (entry.before?.type === "file")
        await workspace.rm(entry.path, { force: true })
      await workspace.mkdir(entry.path, { recursive: true })
      continue
    }
    if (entry.type === "removed") {
      await workspace.rm(entry.path, { force: true, recursive: true })
      continue
    }
    if (entry.after?.type === "file") {
      if (entry.before?.type === "directory")
        await workspace.rm(entry.path, { force: true, recursive: true })
      const before = entry.before?.type === "file"
        ? await workspace.stat(entry.path).catch(() => undefined)
        : undefined
      const file = await readLocalFile(root, entry.path, { preserveSymlink: true })
      if (file)
        await workspace.writeFile(entry.path, file.content, { mediaType: file.mediaType || mediaTypes.get(entry.path) || before?.mediaType, metadata: file.metadata })
    }
  }
  await workspace.snapshot({ name: "local-commit" })
}

async function execLocal(root: string, command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  const cwd = toLocalPath(root, normalizeSessionCwd(options.cwd), { allowGenerated: true })
  if (options.abortSignal?.aborted) return { args, command, exitCode: 130, stderr: "Command aborted", stdout: "" }
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let aborted = false
    let killTimer: NodeJS.Timeout | undefined
    const terminate = () => {
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), 100)
    }
    const abort = () => {
      if (timedOut || aborted) return
      aborted = true
      terminate()
    }
    const timer = options.timeout
      ? setTimeout(() => {
          if (timedOut || aborted) return
          timedOut = true
          terminate()
        }, options.timeout)
      : undefined
    const clearTimers = () => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      options.abortSignal?.removeEventListener("abort", abort)
    }
    options.abortSignal?.addEventListener("abort", abort, { once: true })
    if (options.abortSignal?.aborted) abort()
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", chunk => stdout += chunk)
    child.stderr?.on("data", chunk => stderr += chunk)
    child.on("error", error => {
      clearTimers()
      resolve({
        args,
        command,
        exitCode: aborted ? 130 : 127,
        stderr: aborted ? `${stderr}${stderr ? "\n" : ""}Command aborted` : error instanceof Error ? error.message : String(error),
        stdout,
      })
    })
    child.on("close", (code, signal) => {
      clearTimers()
      resolve({
        args,
        command,
        exitCode: aborted ? 130 : timedOut ? 124 : code ?? 1,
        stderr: aborted
          ? `${stderr}${stderr ? "\n" : ""}Command aborted${signal ? ` (${signal})` : ""}`
          : timedOut ? `${stderr}${stderr ? "\n" : ""}Command timed out${signal ? ` (${signal})` : ""}` : stderr,
        stdout,
      })
    })
  })
}

export async function createTrustedHostWorkspaceSession(
  definition: WorkspaceDefinition,
  workspace: Workspace,
  options?: WorkspaceSessionOptions,
): Promise<WorkspaceSession> {
  assertTrustedHostWorkspaceRuntimeAllowed(definition)
  const root = await mkdtemp(join(tmpdir(), `vitehub-workspace-${workspace.name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "workspace"}-`))
  const sessionPaths = normalizeSessionPaths(options)
  let baseline = await materializeWorkspace(workspace, root, options).catch(async (error) => {
    await rm(root, { force: true, recursive: true })
    throw error
  })
  const mediaTypes = new Map<string, string>()
  let closed = false

  function assertOpen() {
    if (closed)
      throw new WorkspaceError("[vitehub] Workspace trusted-host session is already closed.")
  }

  async function currentDiff() {
    assertOpen()
    return diffSnapshots(baseline, await snapshotLocal(root))
  }

  return {
    async readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, options?: TOptions): Promise<ReadFileResult<TOptions>> {
      assertOpen()
      const workspacePath = assertPathInSessionScope(normalizeLocalWorkspacePath(path, { allowGenerated: true }), sessionPaths, { masked: true })
      const file = await readLocalFile(root, workspacePath, { allowGenerated: true })
      if (!file) throw new WorkspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
      return decodeFile(file.content, options)
    },
    async writeFile(path: string, content: WorkspaceContent, options?: WriteFileOptions) {
      assertOpen()
      const workspacePath = assertPathInSessionScope(normalizeLocalWorkspacePath(path), sessionPaths)
      const target = toLocalPath(root, workspacePath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
      if (options?.mediaType)
        mediaTypes.set(workspacePath, options.mediaType)
      else
        mediaTypes.delete(workspacePath)
    },
    async mkdir(path: string, options = {}) {
      assertOpen()
      await mkdir(toLocalPath(root, assertPathInSessionScope(normalizeLocalWorkspacePath(path, { allowEmpty: true }), sessionPaths, { mkdir: true })), { recursive: options.recursive })
    },
    async rm(path: string, options?: RmOptions) {
      assertOpen()
      const workspacePath = assertPathInSessionScope(normalizeLocalWorkspacePath(path), sessionPaths)
      await rm(toLocalPath(root, workspacePath), { force: options?.force, recursive: options?.recursive })
      mediaTypes.delete(workspacePath)
    },
    async list(path = "", options = {}) {
      assertOpen()
      return filterSessionEntries(await listLocalEntries(root, path, options.recursive, { allowGenerated: true }), sessionPaths)
    },
    async glob(pattern, _options = {}) {
      assertOpen()
      const patterns = Array.isArray(pattern) ? pattern : [pattern]
      return filterSessionEntries(await listLocalEntries(root, "", true, { allowGenerated: true }), sessionPaths)
        .filter(entry => entry.type === "file" && patterns.some(item => matchesAny(entry.path, item)))
    },
    async search(query) {
      assertOpen()
      const { searchText } = await import("../core/search.ts")
      const scoped = scopedSearchQuery(query, sessionPaths, path => normalizeLocalWorkspacePath(path, { allowEmpty: true, allowGenerated: true }))
      if (!scoped) return []
      const searchRoots = [...new Set((scoped.paths?.length ? scoped.paths : [scoped.cwd || ""]).map(path => normalizeLocalWorkspacePath(path, { allowEmpty: true, allowGenerated: true })))]
      const scopedSearchRoots = searchRoots.filter(Boolean)
      const limit = scoped.limit ?? 100
      const hits: WorkspaceSearchHit[] = []
      for (const entry of filterSessionEntries(await listLocalEntries(root, "", true, { allowGenerated: true }), sessionPaths).filter(item => item.type === "file")) {
        if (scopedSearchRoots.length && !scopedSearchRoots.some(path => entry.path === path || entry.path.startsWith(`${path}/`))) continue
        const text = await readFile(toLocalPath(root, entry.path, { allowGenerated: true }), "utf8")
        hits.push(...searchText(entry.path, text, { ...scoped, limit: limit - hits.length }))
        if (hits.length >= limit) break
      }
      return hits
    },
    async diff() {
      return filterSessionDiff(await currentDiff(), sessionPaths)
    },
    async commit(options) {
      const diff = await currentDiff()
      assertDiffInsideSessionPaths(diff, sessionPaths)
      await commitLocalChanges(root, workspace, diff, mediaTypes)
      baseline = await snapshotLocal(root, options?.message || "local-commit")
    },
    async exec(command, args = [], options = {}) {
      assertOpen()
      return await execLocal(root, command, args, options)
    },
    async close() {
      if (closed) return
      closed = true
      await rm(root, { force: true, recursive: true })
    },
  }
}
