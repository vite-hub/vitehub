import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, posix, relative, sep } from "node:path"

import { WorkspaceError } from "../core/errors.ts"
import { contentToBytes, decodeFile, matchesAny, normalizeSafeWorkspacePath, normalizeWorkspacePath, resolveInside, sha256 } from "../core/path.ts"
import { createSnapshotFromEntries, diffSnapshots } from "../storage/utils.ts"

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
} from "../core/types.ts"

function assertTrustedHostWorkspaceRuntimeAllowed() {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  if (env?.NODE_ENV === "production") {
    throw new WorkspaceError("[vitehub] Workspace runtime `trusted-host` is only available outside production. Use `runtime: 'sandbox'` for hosted executable workspaces.")
  }
}

function toWorkspacePath(root: string, path: string) {
  return normalizeWorkspacePath(relative(root, path).split(sep).join("/"))
}

function isGeneratedSourceDescriptorPath(path: string): boolean {
  return path === ".vitehub" || path === ".vitehub/sources" || /^\.vitehub\/sources\/[^/]+\.json$/.test(path)
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
  return normalizeLocalWorkspacePath(normalized.replace(/^\/workspace(?:\/|$)/, ""), { allowEmpty: true })
}

function toLocalPath(root: string, path = "", options: { allowGenerated?: boolean } = {}) {
  return resolveInside(root, normalizeLocalWorkspacePath(path, { allowEmpty: true, allowGenerated: options.allowGenerated }))
}

async function listLocalEntries(root: string, path = "", recursive = false, options: { allowGenerated?: boolean, skipGenerated?: boolean } = {}): Promise<WorkspaceEntry[]> {
  const base = toLocalPath(root, path, options)
  const dirents = await readdir(base, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  })
  const entries: WorkspaceEntry[] = []
  for (const dirent of dirents) {
    const entryPath = join(base, dirent.name)
    const workspacePath = toWorkspacePath(root, entryPath)
    if (options.skipGenerated && isGeneratedSourceDescriptorPath(workspacePath)) continue
    if (dirent.isDirectory()) {
      entries.push({ path: workspacePath, type: "directory" })
      if (recursive) entries.push(...await listLocalEntries(root, workspacePath, true, options))
      continue
    }
    if (!dirent.isFile()) continue
    const item = await stat(entryPath)
    entries.push({ path: workspacePath, size: item.size, type: "file" })
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

async function readLocalFile(root: string, path: string, options: { allowGenerated?: boolean } = {}): Promise<WorkspaceFile | undefined> {
  const target = toLocalPath(root, path, options)
  try {
    return { content: await readFile(target), path: normalizeWorkspacePath(path) }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function snapshotLocal(root: string, name?: string) {
  const entries = await listLocalEntries(root, "", true, { allowGenerated: true, skipGenerated: true })
  const files = await Promise.all(entries.map(async (entry) => {
    if (entry.type !== "file") return entry
    const content = await readFile(toLocalPath(root, entry.path))
    return {
      ...entry,
      digest: await sha256(content),
      size: contentToBytes(content).byteLength,
    }
  }))
  return await createSnapshotFromEntries(files, name)
}

async function materializeWorkspace(workspace: Workspace, root: string) {
  const entries = await workspace.list("", { recursive: true })
  for (const entry of entries.filter(entry => entry.type === "directory"))
    await mkdir(toLocalPath(root, entry.path, { allowGenerated: true }), { recursive: true })
  for (const entry of entries) {
    if (entry.type !== "file") continue
    const target = toLocalPath(root, entry.path, { allowGenerated: true })
    await mkdir(dirname(target), { recursive: true })
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
    if (isGeneratedSourceDescriptorPath(entry.path)) continue
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
      const file = await readLocalFile(root, entry.path)
      if (file)
        await workspace.writeFile(entry.path, file.content, { mediaType: file.mediaType || mediaTypes.get(entry.path) || before?.mediaType })
    }
  }
  await workspace.snapshot({ name: "local-commit" })
}

async function execLocal(root: string, command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  const cwd = toLocalPath(root, normalizeSessionCwd(options.cwd))
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const timer = options.timeout
      ? setTimeout(() => {
          settled = true
          child.kill("SIGTERM")
          killTimer = setTimeout(() => child.kill("SIGKILL"), 100)
        }, options.timeout)
      : undefined
    const clearTimers = () => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
    }
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", chunk => stdout += chunk)
    child.stderr?.on("data", chunk => stderr += chunk)
    child.on("error", error => {
      clearTimers()
      resolve({ args, command, exitCode: 127, stderr: error instanceof Error ? error.message : String(error), stdout })
    })
    child.on("close", (code, signal) => {
      clearTimers()
      resolve({
        args,
        command,
        exitCode: settled ? 124 : code ?? 1,
        stderr: settled ? `${stderr}${stderr ? "\n" : ""}Command timed out${signal ? ` (${signal})` : ""}` : stderr,
        stdout,
      })
    })
  })
}

export async function createTrustedHostWorkspaceSession(
  _definition: WorkspaceDefinition,
  workspace: Workspace,
): Promise<WorkspaceSession> {
  assertTrustedHostWorkspaceRuntimeAllowed()
  const root = await mkdtemp(join(tmpdir(), `vitehub-workspace-${workspace.name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "workspace"}-`))
  let baseline = await materializeWorkspace(workspace, root)
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
      const file = await readLocalFile(root, normalizeLocalWorkspacePath(path, { allowGenerated: true }), { allowGenerated: true })
      if (!file) throw new WorkspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
      return decodeFile(file.content, options)
    },
    async writeFile(path: string, content: WorkspaceContent, options?: WriteFileOptions) {
      assertOpen()
      const workspacePath = normalizeLocalWorkspacePath(path)
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
      await mkdir(toLocalPath(root, path), { recursive: options.recursive })
    },
    async rm(path: string, options?: RmOptions) {
      assertOpen()
      const workspacePath = normalizeLocalWorkspacePath(path)
      await rm(toLocalPath(root, workspacePath), { force: options?.force, recursive: options?.recursive })
      mediaTypes.delete(workspacePath)
    },
    async list(path = "", options = {}) {
      assertOpen()
      return await listLocalEntries(root, path, options.recursive, { allowGenerated: true })
    },
    async glob(pattern, _options = {}) {
      assertOpen()
      const patterns = Array.isArray(pattern) ? pattern : [pattern]
      return (await listLocalEntries(root, "", true, { allowGenerated: true }))
        .filter(entry => entry.type === "file" && patterns.some(item => matchesAny(entry.path, item)))
    },
    async search(query) {
      assertOpen()
      const { searchText } = await import("../core/search.ts")
      const searchRoots = [...new Set((query.paths?.length ? query.paths : [query.cwd || ""]).map(path => normalizeLocalWorkspacePath(path, { allowEmpty: true, allowGenerated: true })))]
      const scopedSearchRoots = searchRoots.filter(Boolean)
      const limit = query.limit ?? 100
      const hits: WorkspaceSearchHit[] = []
      for (const entry of (await listLocalEntries(root, "", true, { allowGenerated: true })).filter(item => item.type === "file")) {
        if (scopedSearchRoots.length && !scopedSearchRoots.some(path => entry.path === path || entry.path.startsWith(`${path}/`))) continue
        const text = await readFile(toLocalPath(root, entry.path, { allowGenerated: true }), "utf8")
        hits.push(...searchText(entry.path, text, { ...query, limit: limit - hits.length }))
        if (hits.length >= limit) break
      }
      return hits
    },
    async diff() {
      return await currentDiff()
    },
    async commit(options) {
      const diff = await currentDiff()
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
