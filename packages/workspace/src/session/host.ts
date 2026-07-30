import { posix } from "node:path"
import { normalizeExecutionAuthority } from "@vite-hub/runtime"

import { workspaceError } from "../core/errors.ts"
import { contentToBytes, decodeFile, normalizeSafeWorkspacePath, normalizeWorkspacePath, sha256 } from "../core/path.ts"
import { createSnapshotFromEntries, diffSnapshots } from "../storage/utils.ts"
import { normalizeHostTarget, toHostCwd, toHostPath } from "./host-path.ts"
import { assertDiffInsideSessionPaths, assertPathInSessionScope, filterSessionDiff, filterSessionEntries, isMissingWorkspacePathError, scopedSearchQuery } from "./scope.ts"

import type {
  ReadFileOptions,
  ReadFileResult,
  RmOptions,
  Workspace,
  WorkspaceContent,
  WorkspaceDiff,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceSearchHit,
  WorkspaceSession,
  WorkspaceSessionHost,
  WorkspaceSessionHostFileEntry,
  WorkspaceSessionOptions,
  WriteFileOptions,
} from "../core/types.ts"

function normalizeSearchRoot(path: string) {
  const normalized = posix.normalize(path.replace(/\\/g, "/"))
  return normalized === "." ? "" : normalizeSafeWorkspacePath(normalized, { allowEmpty: true })
}

function fromHostPath(root: string, path: string) {
  const normalizedRoot = root.replace(/\/+$/, "")
  const normalizedPath = posix.resolve(root, path).replace(/\/+$/, "")
  if (normalizedPath === normalizedRoot) return ""
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) {
    throw workspaceError(`[vitehub] Workspace host returned a path outside ${root}: ${path}.`)
  }
  return normalizeWorkspacePath(normalizedPath.slice(normalizedRoot.length + 1))
}

function isGitSymlinkEntry(entry: WorkspaceEntry): boolean {
  return entry.metadata?.gitMode === "120000"
}

function hasSymlinkParent(path: string, symlinks: Set<string>) {
  let parent = posix.dirname(path)
  while (parent && parent !== "." && parent !== "/") {
    if (symlinks.has(parent)) return true
    parent = posix.dirname(parent)
  }
  return false
}

function isSafeHostSymlink(root: string, path: string, target: string) {
  if (posix.isAbsolute(target)) return false
  const resolved = posix.resolve(posix.dirname(toHostPath(root, path)), target)
  return resolved === root || resolved.startsWith(`${root}/`)
}

async function assertNoHostSymlinkParent(host: WorkspaceSessionHost, root: string, target: string) {
  const path = fromHostPath(root, target)
  const symlinks = new Set((await listHostEntries(host, root, "", true))
    .filter(isGitSymlinkEntry)
    .map(entry => entry.path))
  if (hasSymlinkParent(path, symlinks))
    throw workspaceError(`[vitehub] Workspace host path crosses a symlink parent: ${path}.`)
}

function toWorkspaceEntry(root: string, entry: WorkspaceSessionHostFileEntry): WorkspaceEntry {
  return {
    metadata: entry.type === "symlink" ? { gitMode: "120000" } : undefined,
    path: fromHostPath(root, entry.path),
    size: entry.size,
    type: entry.type === "directory" ? "directory" : "file",
  }
}

async function ensureHostParent(host: WorkspaceSessionHost, path: string) {
  const parent = posix.dirname(path)
  if (parent && parent !== "." && parent !== "/")
    await host.files.mkdir(parent, { recursive: true })
}

async function readHostSymlinkTarget(host: WorkspaceSessionHost, root: string, path: string): Promise<string> {
  const result = await host.exec("readlink", [fromHostPath(root, path)], { cwd: root })
  if (result.code !== 0)
    throw workspaceError(`[vitehub] Failed to read workspace symlink: ${path}.`, {
      cause: new Error(result.stderr || "readlink failed"),
    })
  return result.stdout.replace(/\n$/, "")
}

async function writeHostSymlink(host: WorkspaceSessionHost, root: string, path: string, target: string) {
  await host.files.remove(path).catch(() => undefined)
  const result = await host.exec("ln", ["-s", target, fromHostPath(root, path)], { cwd: root })
  if (result.code !== 0)
    throw workspaceError(`[vitehub] Failed to create workspace symlink: ${path}. ${result.stderr || "ln failed"}`)
}

async function readHostFile(host: WorkspaceSessionHost, root: string, path: string): Promise<WorkspaceFile | undefined> {
  if (!await host.files.exists(path)) return undefined
  const content = await host.files.read(path)
  return content ? { content, path: fromHostPath(root, path) } : undefined
}

async function listHostEntries(host: WorkspaceSessionHost, root: string, path = "", recursive = false): Promise<WorkspaceEntry[]> {
  const entries = await host.files.list(toHostPath(root, path), { recursive })
  const resolved = await Promise.all(entries.map(async (entry) => {
    const workspaceEntry = toWorkspaceEntry(root, entry)
    if (workspaceEntry.type !== "file" || isGitSymlinkEntry(workspaceEntry)) return workspaceEntry
    const executable = await host.exec("test", ["-x", fromHostPath(root, entry.path)], { cwd: root })
    return executable.code === 0
      ? { ...workspaceEntry, metadata: { ...workspaceEntry.metadata, gitMode: "100755" } }
      : workspaceEntry
  }))
  return resolved
    .filter(entry => entry.path && entry.path !== ".git" && !entry.path.startsWith(".git/"))
    .sort((left, right) => left.path.localeCompare(right.path))
}

async function makeHostFileExecutable(host: WorkspaceSessionHost, root: string, path: string) {
  const result = await host.exec("chmod", ["+x", fromHostPath(root, path)], { cwd: root })
  if (result.code !== 0)
    throw workspaceError(`[vitehub] Failed to preserve executable Workspace file: ${path}. ${result.stderr || "chmod failed"}`)
}

async function snapshotHost(host: WorkspaceSessionHost, root: string, name?: string) {
  return (await captureHostState(host, root, name)).snapshot
}

async function captureHostState(host: WorkspaceSessionHost, root: string, name?: string) {
  const entries = await listHostEntries(host, root, "", true)
  const contents = new Map<string, Uint8Array | string>()
  const files = await Promise.all(entries.map(async (entry) => {
    if (entry.type !== "file") return entry
    const content = isGitSymlinkEntry(entry)
      ? await readHostSymlinkTarget(host, root, toHostPath(root, entry.path))
      : await host.files.read(toHostPath(root, entry.path))
    if (content === null) throw workspaceError(`[vitehub] Workspace host file disappeared while snapshotting: ${entry.path}.`)
    contents.set(entry.path, content)
    return {
      ...entry,
      digest: await sha256(content),
      size: contentToBytes(content).byteLength,
    }
  }))
  return { contents, snapshot: await createSnapshotFromEntries(files, name) }
}

async function restoreAttachedHost(
  host: WorkspaceSessionHost,
  root: string,
  diff: WorkspaceDiff,
  state: Awaited<ReturnType<typeof captureHostState>>,
) {
  const changed = [...new Set(diff.entries.map(entry => entry.path))]
  for (const path of changed.sort((left, right) => right.length - left.length))
    await host.files.remove(toHostPath(root, path), { recursive: true }).catch(() => undefined)

  const baselineEntries = changed
    .map(path => [path, state.snapshot.entries[path]] as const)
    .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => Boolean(entry[1]))
    .sort(([left], [right]) => left.split("/").length - right.split("/").length)
  for (const [path, entry] of baselineEntries) {
    const target = toHostPath(root, path)
    if (entry.type === "directory") {
      await host.files.mkdir(target, { recursive: true })
      continue
    }
    const content = state.contents.get(path)
    if (content === undefined) continue
    await ensureHostParent(host, target)
    if (entry.metadata?.gitMode === "120000") await writeHostSymlink(host, root, target, String(content))
    else {
      await host.files.write(target, contentToBytes(content))
      if (entry.metadata?.gitMode === "100755") await makeHostFileExecutable(host, root, target)
    }
  }
}

async function resetHostWorkspaceRoot(host: WorkspaceSessionHost, root: string) {
  await host.files.remove(root, { recursive: true }).catch(() => undefined)
  await host.files.mkdir(root, { recursive: true })
}

function normalizeSessionPaths(options?: WorkspaceSessionOptions): string[] | undefined {
  const paths = [...new Set((options?.paths || []).map(path => normalizeSafeWorkspacePath(path, { allowEmpty: true, allowReserved: true })))]
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

async function materializeWorkspace(workspace: Workspace, host: WorkspaceSessionHost, root: string, options?: WorkspaceSessionOptions) {
  await resetHostWorkspaceRoot(host, root)
  const entries = await sessionEntries(workspace, options)
  const symlinks = new Set(entries.filter(isGitSymlinkEntry).map(entry => entry.path))
  const nested = entries.find(entry => hasSymlinkParent(entry.path, symlinks))
  if (nested)
    throw workspaceError(`[vitehub] Workspace path crosses a symlink parent: ${nested.path}.`)
  for (const entry of entries.filter(entry => entry.type === "directory"))
    await host.files.mkdir(toHostPath(root, entry.path), { recursive: true })
  for (const entry of entries) {
    if (entry.type !== "file") continue
    const target = toHostPath(root, entry.path)
    await ensureHostParent(host, target)
    if (isGitSymlinkEntry(entry)) {
      const symlinkTarget = typeof entry.metadata?.symlinkTarget === "string"
        ? entry.metadata.symlinkTarget
        : new TextDecoder().decode(contentToBytes(await workspace.readFile(entry.path, { encoding: "binary" })))
      if (isSafeHostSymlink(root, entry.path, symlinkTarget))
        await writeHostSymlink(host, root, target, symlinkTarget)
      else
        await host.files.write(target, contentToBytes(symlinkTarget))
    }
    else {
      await host.files.write(target, contentToBytes(await workspace.readFile(entry.path, { encoding: "binary" })))
      if (entry.metadata?.gitMode === "100755") await makeHostFileExecutable(host, root, target)
    }
  }
  return await snapshotHost(host, root, "host-open")
}

async function commitHostChanges(
  host: WorkspaceSessionHost,
  root: string,
  workspace: Workspace,
  diff: WorkspaceDiff,
  mediaTypes: Map<string, string>,
  message?: string,
) {
  for (const entry of diff.entries) {
    if (entry.after?.type === "directory") {
      if (entry.before?.type === "file") await workspace.rm(entry.path, { force: true })
      await workspace.mkdir(entry.path, { recursive: true })
      continue
    }
    if (entry.type === "removed") {
      await workspace.rm(entry.path, { force: true, recursive: true })
      continue
    }
    if (entry.after?.type !== "file") continue
    if (entry.before?.type === "directory") await workspace.rm(entry.path, { force: true, recursive: true })
    const before = entry.before?.type === "file"
      ? await workspace.stat(entry.path).catch(() => undefined)
      : undefined
    const target = toHostPath(root, entry.path)
    const symlinkTarget = entry.after.metadata?.gitMode === "120000"
      ? await readHostSymlinkTarget(host, root, target)
      : undefined
    const file = symlinkTarget === undefined
      ? await readHostFile(host, root, target)
      : isSafeHostSymlink(root, entry.path, symlinkTarget)
          ? { content: symlinkTarget, metadata: entry.after.metadata, path: entry.path }
          : { content: symlinkTarget, path: entry.path }
    if (file) {
      await workspace.writeFile(entry.path, file.content, {
        mediaType: file.mediaType || mediaTypes.get(entry.path) || before?.mediaType,
        metadata: symlinkTarget === undefined ? entry.after.metadata : file.metadata,
      })
    }
  }
  await workspace.snapshot({ name: message || "host-commit" })
}

export async function createHostedWorkspaceSession(
  workspace: Workspace,
  options: WorkspaceSessionOptions & { host: WorkspaceSessionHost },
): Promise<WorkspaceSession> {
  const host = options.host
  if (!options.attach && host.files.localPath) {
    const { tryCreateMountXHostedWorkspaceSession } = await import("./mountx-host.ts")
    const root = normalizeHostTarget(options.target)
    const projected = await tryCreateMountXHostedWorkspaceSession(
      workspace,
      options,
      undefined,
      async () => {
        await materializeWorkspace(workspace, host, root, options)
      },
    )
    if (projected) return projected
  }
  let executionAuthority
  try {
    executionAuthority = normalizeExecutionAuthority(host.executionAuthority)
  }
  catch {
    throw new TypeError("[vitehub] Workspace session host must declare executionAuthority.")
  }
  const root = normalizeHostTarget(options.target)
  const sessionPaths = normalizeSessionPaths(options)
  let closed = false
  let attachedState = options.attach ? await captureHostState(host, root, "host-attach") : undefined
  let baseline = attachedState?.snapshot || await materializeWorkspace(workspace, host, root, options)
  const mediaTypes = new Map<string, string>()

  function assertOpen() {
    if (closed) throw workspaceError("[vitehub] Workspace host session is already closed.")
  }

  async function currentDiff() {
    assertOpen()
    return diffSnapshots(baseline, await snapshotHost(host, root))
  }

  return {
    executionAuthority,
    async readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, readOptions?: TOptions): Promise<ReadFileResult<TOptions>> {
      assertOpen()
      const target = toHostPath(root, assertPathInSessionScope(normalizeSafeWorkspacePath(path), sessionPaths, { masked: true }))
      const file = await readHostFile(host, root, target)
      if (!file) throw workspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
      return decodeFile(file.content, readOptions)
    },
    async writeFile(path: string, content: WorkspaceContent, writeOptions?: WriteFileOptions) {
      assertOpen()
      const target = toHostPath(root, assertPathInSessionScope(normalizeSafeWorkspacePath(path), sessionPaths))
      await assertNoHostSymlinkParent(host, root, target)
      await ensureHostParent(host, target)
      await host.files.remove(target, { recursive: true }).catch(() => undefined)
      const symlinkTarget = writeOptions?.metadata?.gitMode === "120000"
        ? new TextDecoder().decode(contentToBytes(content))
        : undefined
      if (symlinkTarget !== undefined && isSafeHostSymlink(root, fromHostPath(root, target), symlinkTarget))
        await writeHostSymlink(host, root, target, symlinkTarget)
      else {
        await host.files.write(target, contentToBytes(content))
        const workspacePath = fromHostPath(root, target)
        const preserveExecutable = writeOptions?.metadata?.gitMode === "100755"
          || baseline.entries[workspacePath]?.metadata?.gitMode === "100755"
        if (preserveExecutable) await makeHostFileExecutable(host, root, target)
      }
      const workspacePath = fromHostPath(root, target)
      if (writeOptions?.mediaType) mediaTypes.set(workspacePath, writeOptions.mediaType)
      else mediaTypes.delete(workspacePath)
    },
    async mkdir(path: string, mkdirOptions = {}) {
      assertOpen()
      const target = assertPathInSessionScope(normalizeSafeWorkspacePath(path, { allowEmpty: true }), sessionPaths, { mkdir: true })
      const hostTarget = toHostPath(root, target)
      await assertNoHostSymlinkParent(host, root, hostTarget)
      await host.files.mkdir(hostTarget, { recursive: mkdirOptions.recursive })
    },
    async rm(path: string, rmOptions?: RmOptions) {
      assertOpen()
      const workspacePath = assertPathInSessionScope(normalizeSafeWorkspacePath(path), sessionPaths)
      const target = toHostPath(root, workspacePath)
      await assertNoHostSymlinkParent(host, root, target)
      await host.files.remove(target, { recursive: rmOptions?.recursive })
      mediaTypes.delete(normalizeWorkspacePath(workspacePath))
    },
    async list(path = "", listOptions = {}) {
      assertOpen()
      return filterSessionEntries(await listHostEntries(host, root, path, listOptions.recursive), sessionPaths)
    },
    async glob(pattern, globOptions) {
      assertOpen()
      const patterns = Array.isArray(pattern) ? pattern : [pattern]
      const cwd = normalizeSearchRoot(globOptions?.cwd || "")
      const { matchesAny } = await import("../core/path.ts")
      return filterSessionEntries(await listHostEntries(host, root, "", true), sessionPaths)
        .filter((entry) => {
          if (entry.type !== "file") return false
          if (!cwd) return patterns.some(item => matchesAny(entry.path, item))
          if (!entry.path.startsWith(`${cwd}/`)) return false
          const relative = entry.path.slice(cwd.length + 1)
          return patterns.some(item => matchesAny(relative, item))
        })
    },
    async search(query) {
      assertOpen()
      const { searchText } = await import("../core/search.ts")
      const scoped = scopedSearchQuery(query, sessionPaths, normalizeSearchRoot)
      if (!scoped) return []
      const searchRoots = [...new Set((scoped.paths?.length ? scoped.paths : [scoped.cwd || ""]).map(normalizeSearchRoot))]
      const scopedSearchRoots = searchRoots.filter(Boolean)
      const limit = scoped.limit ?? 100
      const hits: WorkspaceSearchHit[] = []
      for (const entry of filterSessionEntries(await listHostEntries(host, root, "", true), sessionPaths).filter(item => item.type === "file")) {
        if (scopedSearchRoots.length && !scopedSearchRoots.some(path => entry.path === path || entry.path.startsWith(`${path}/`))) continue
        const content = await host.files.read(toHostPath(root, entry.path))
        if (content === null) continue
        const text = new TextDecoder().decode(content)
        hits.push(...searchText(entry.path, text, { ...scoped, limit: limit - hits.length }))
        if (hits.length >= limit) break
      }
      return hits
    },
    async diff() {
      return filterSessionDiff(await currentDiff(), sessionPaths)
    },
    async commit(commitOptions) {
      const diff = await currentDiff()
      if (!diff.entries.length) return
      assertDiffInsideSessionPaths(diff, sessionPaths)
      await commitHostChanges(host, root, workspace, diff, mediaTypes, commitOptions?.message)
      if (options.attach) {
        attachedState = await captureHostState(host, root, commitOptions?.message || "host-commit")
        baseline = attachedState.snapshot
      }
      else baseline = await snapshotHost(host, root, commitOptions?.message || "host-commit")
    },
    async exec(command, args = [], execOptions = {}) {
      assertOpen()
      const result = await host.exec(command, args, {
        cwd: toHostCwd(root, execOptions.cwd),
        env: execOptions.env,
        signal: execOptions.abortSignal,
        timeout: execOptions.timeout,
      })
      return { args, command, exitCode: result.code, stderr: result.stderr, stdout: result.stdout }
    },
    async close() {
      if (closed) return
      if (options.attach && attachedState) {
        const diff = filterSessionDiff(diffSnapshots(baseline, await snapshotHost(host, root)), sessionPaths)
        await restoreAttachedHost(host, root, diff, attachedState)
      }
      closed = true
      if (!options.attach) await materializeWorkspace(workspace, host, root, options)
    },
  }
}
