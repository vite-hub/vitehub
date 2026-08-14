import { randomUUID } from "node:crypto"
import { posix } from "node:path"
import { normalizeExecutionAuthority } from "@vite-hub/runtime"

import { workspaceConflict, workspaceError } from "../core/errors.ts"
import { contentToBytes, decodeFile, normalizeSafeWorkspacePath, normalizeWorkspacePath, sha256 } from "../core/path.ts"
import { createSnapshotFromEntries, diffSnapshots } from "../storage/utils.ts"
import { assertDiffInsideSessionPaths, assertPathInSessionScope, filterSessionDiff, filterSessionEntries, isMissingWorkspacePathError, scopedSearchQuery } from "./scope.ts"
import { withWorkspaceProgress } from "./progress.ts"
import { resolveWorkspaceRevisionMaterializer } from "../storage/materialization.ts"

import type { WorkspaceRevisionMaterialization } from "../storage/materialization.ts"

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
  WorkspaceSnapshot,
  WorkspaceSessionWriteFileOptions,
} from "../core/types.ts"

const publicationQueues = new WeakMap<object, Promise<void>>()
const hostInspectionConcurrency = 16

async function mapWithConcurrency<T, U>(values: readonly T[], concurrency: number, visit: (value: T) => Promise<U>) {
  const results = new Array<U>(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++
      results[index] = await visit(values[index]!)
    }
  }))
  return results
}

async function withWorkspacePublication<T>(key: object, publish: () => Promise<T>): Promise<T> {
  const previous = publicationQueues.get(key) || Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  publicationQueues.set(key, current)
  await previous
  try {
    return await publish()
  }
  finally {
    release()
    if (publicationQueues.get(key) === current) publicationQueues.delete(key)
  }
}

function normalizeTarget(target = "/workspace") {
  const normalized = posix.resolve("/", target.replace(/\\/g, "/"))
  if (normalized === "/") throw workspaceError("[vitehub] Workspace session target cannot be the host root.")
  return normalized
}

function normalizeSearchRoot(path: string) {
  const normalized = posix.normalize(path.replace(/\\/g, "/"))
  return normalized === "." ? "" : normalizeSafeWorkspacePath(normalized, { allowEmpty: true })
}

function normalizeReadableSessionPath(path: string) {
  const normalized = normalizeSafeWorkspacePath(path, { allowReserved: true })
  if (/^\.vitehub\/sources\/[^/]+\.json$/.test(normalized)) return normalized
  return normalizeSafeWorkspacePath(path)
}

function toHostPath(root: string, path = "") {
  const normalized = normalizeSafeWorkspacePath(path, { allowEmpty: true, allowReserved: true })
  return normalized ? posix.join(root, normalized) : root
}

function toHostCwd(root: string, cwd: string | undefined) {
  if (cwd === undefined) return root
  if (!posix.isAbsolute(cwd)) return toHostPath(root, cwd)
  const normalized = posix.normalize(cwd)
  if (normalized === root || normalized.startsWith(`${root}/`)) return normalized
  if (normalized === "/workspace" || normalized.startsWith("/workspace/"))
    return toHostPath(root, normalized.slice("/workspace".length))
  throw workspaceError(`[vitehub] Workspace exec cwd must stay inside ${root}: ${cwd}.`)
}

function fromHostPath(root: string, path: string) {
  const normalizedRoot = root.replace(/\/+$/, "")
  const normalizedPath = posix.resolve(root, path).replace(/\/+$/, "")
  if (normalizedPath === normalizedRoot) return ""
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) {
    throw workspaceError(`[vitehub] Workspace host returned a path outside ${root}: ${path}.`)
  }
  return normalizeSafeWorkspacePath(normalizedPath.slice(normalizedRoot.length + 1), { allowReserved: true })
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

async function isHostPath(host: WorkspaceSessionHost, path: string, flag: "-d" | "-L") {
  return (await host.exec("test", [flag, path])).code === 0
}

async function assertHostWorkspaceRoot(host: WorkspaceSessionHost, root: string) {
  if (await isHostPath(host, root, "-L") || !await isHostPath(host, root, "-d"))
    throw workspaceError(`[vitehub] Workspace host root must be a directory: ${root}.`)
}

async function ensureHostWorkspaceRoot(host: WorkspaceSessionHost, root: string) {
  const symlink = await isHostPath(host, root, "-L")
  const directory = !symlink && await isHostPath(host, root, "-d")
  if (directory) return false
  if (symlink || await host.files.exists(root)) await host.files.remove(root, { recursive: false })
  await host.files.mkdir(root, { recursive: true })
  await assertHostWorkspaceRoot(host, root)
  return true
}

async function removeHostSymlinkAncestors(host: WorkspaceSessionHost, root: string, path: string) {
  let ancestor = root
  for (const component of fromHostPath(root, path).split("/").slice(0, -1)) {
    ancestor = posix.join(ancestor, component)
    if (!await isHostPath(host, ancestor, "-L")) continue
    await host.files.remove(ancestor, { recursive: false })
    if (await isHostPath(host, ancestor, "-L"))
      throw workspaceError(`[vitehub] Failed to remove Workspace symlink ancestor: ${ancestor}.`)
    return
  }
}

async function removeHostPath(host: WorkspaceSessionHost, root: string, path: string, recursive: boolean) {
  await removeHostSymlinkAncestors(host, root, path)
  await host.files.remove(path, { recursive: await isHostPath(host, path, "-L") ? false : recursive })
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
  await removeHostPath(host, root, path, false)
  const result = await host.exec("ln", ["-s", target, fromHostPath(root, path)], { cwd: root })
  if (result.code !== 0)
    throw workspaceError(`[vitehub] Failed to create workspace symlink: ${path}. ${result.stderr || "ln failed"}`)
}

async function readHostFile(host: WorkspaceSessionHost, root: string, path: string): Promise<WorkspaceFile | undefined> {
  await assertHostWorkspaceRoot(host, root)
  if (!await host.files.exists(path)) return undefined
  const content = await host.files.read(path)
  return content ? { content, path: fromHostPath(root, path) } : undefined
}

async function listHostEntries(
  host: WorkspaceSessionHost,
  root: string,
  path = "",
  recursive = false,
  include?: (entry: WorkspaceEntry) => boolean,
  includeGit = false,
): Promise<WorkspaceEntry[]> {
  await assertHostWorkspaceRoot(host, root)
  const entries = (await host.files.list(toHostPath(root, path), { recursive }))
    .map(entry => toWorkspaceEntry(root, entry))
    .filter(entry => !include || include(entry))
  const resolved = await mapWithConcurrency(entries, hostInspectionConcurrency, async (workspaceEntry) => {
    if (workspaceEntry.type !== "file" || isGitSymlinkEntry(workspaceEntry)) return workspaceEntry
    const executable = await host.exec("test", ["-x", workspaceEntry.path], { cwd: root })
    return executable.code === 0
      ? { ...workspaceEntry, metadata: { ...workspaceEntry.metadata, gitMode: "100755" } }
      : workspaceEntry
  })
  return resolved
    .filter(entry => entry.path && (includeGit || (entry.path !== ".git" && !entry.path.startsWith(".git/"))))
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
  if (await isHostPath(host, root, "-L"))
    throw workspaceError(`[vitehub] Workspace host root must be a directory: ${root}.`)
  if (!await host.files.exists(root)) {
    return { contents: new Map<string, Uint8Array | string>(), snapshot: await createSnapshotFromEntries([], name) }
  }
  const entries = await listHostEntries(host, root, "", true)
  return await captureHostEntriesState(host, root, entries, name)
}

async function captureHostEntriesState(host: WorkspaceSessionHost, root: string, entries: WorkspaceEntry[], name?: string) {
  const contents = new Map<string, Uint8Array | string>()
  const files = await mapWithConcurrency(entries, hostInspectionConcurrency, async (entry) => {
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
  })
  return { contents, snapshot: await createSnapshotFromEntries(files, name) }
}

function isInsideExcludedWriteBackPath(path: string, excluded: readonly string[]) {
  return excluded.some(item => path === item || path.startsWith(`${item}/`))
}

async function captureExcludedHostState(host: WorkspaceSessionHost, root: string, excluded: readonly string[]) {
  if (await isHostPath(host, root, "-L"))
    throw workspaceError(`[vitehub] Workspace host root must be a directory: ${root}.`)
  if (!await host.files.exists(root)) return await captureHostEntriesState(host, root, [], "host-excluded")
  const entries = await listHostEntries(host, root, "", true, entry => isInsideExcludedWriteBackPath(entry.path, excluded), true)
  return await captureHostEntriesState(host, root, entries, "host-excluded")
}

function mergeExcludedHostState(
  before: Awaited<ReturnType<typeof captureExcludedHostState>>,
  materialized: Awaited<ReturnType<typeof captureExcludedHostState>>,
  excluded: readonly string[],
) {
  const occupiedRoots = excluded.filter(root => Object.keys(before.snapshot.entries)
    .some(path => path === root || path.startsWith(`${root}/`)))
  const entries = Object.fromEntries(Object.entries(materialized.snapshot.entries)
    .filter(([path]) => !occupiedRoots.some(root => path === root || path.startsWith(`${root}/`))))
  const contents = new Map(materialized.contents)
  for (const root of occupiedRoots) {
    for (const path of [...contents.keys()]) {
      if (path === root || path.startsWith(`${root}/`)) contents.delete(path)
    }
  }
  for (const [path, entry] of Object.entries(before.snapshot.entries)) entries[path] = entry
  for (const [path, content] of before.contents) contents.set(path, content)
  return { contents, snapshot: { ...materialized.snapshot, entries } }
}

async function restoreExcludedHostState(
  host: WorkspaceSessionHost,
  root: string,
  excluded: readonly string[],
  state: Awaited<ReturnType<typeof captureExcludedHostState>>,
) {
  const roots = excluded.filter((path, index) => !excluded.some((parent, parentIndex) => parentIndex !== index && path.startsWith(`${parent}/`)))
  for (const path of roots.sort((left, right) => right.length - left.length)) {
    await removeHostPath(host, root, toHostPath(root, path), true)
  }

  const entries = Object.entries(state.snapshot.entries)
    .sort(([left], [right]) => left.split("/").length - right.split("/").length)
  for (const [path, entry] of entries) {
    const target = toHostPath(root, path)
    await removeHostSymlinkAncestors(host, root, target)
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

async function restoreAttachedHost(
  host: WorkspaceSessionHost,
  root: string,
  diff: WorkspaceDiff,
  state: Awaited<ReturnType<typeof captureHostState>>,
) {
  const changed = [...new Set(diff.entries.map(entry => entry.path))]
  for (const path of changed.sort((left, right) => right.length - left.length)) {
    await removeHostPath(host, root, toHostPath(root, path), true)
  }

  const baselineEntries = changed
    .map(path => [path, state.snapshot.entries[path]] as const)
    .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => Boolean(entry[1]))
    .sort(([left], [right]) => left.split("/").length - right.split("/").length)
  for (const [path, entry] of baselineEntries) {
    const target = toHostPath(root, path)
    await removeHostSymlinkAncestors(host, root, target)
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
  if (await ensureHostWorkspaceRoot(host, root)) return
  for (const entry of await host.files.list(root)) {
    await removeHostPath(host, root, entry.path, true)
  }
}

function isExcludedWriteBackPath(path: string, excluded: readonly string[]) {
  return excluded.some(item => path === item || path.startsWith(`${item}/`) || item.startsWith(`${path}/`))
}

function filterWriteBackDiff(diff: WorkspaceDiff, excluded: readonly string[]): WorkspaceDiff {
  return {
    ...diff,
    entries: diff.entries.filter(entry => !isExcludedWriteBackPath(entry.path, excluded)),
  }
}

function normalizeSessionPaths(options?: WorkspaceSessionOptions): string[] | undefined {
  if (options?.paths === undefined) return undefined
  const paths = [...new Set(options.paths.map(path => normalizeSafeWorkspacePath(path, { allowEmpty: true, allowReserved: true })))]
  if (paths.includes("")) return undefined
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

async function extractRevisionArchive(
  host: WorkspaceSessionHost,
  root: string,
  materialization: WorkspaceRevisionMaterialization & { archive: Uint8Array },
  signal?: AbortSignal,
) {
  const stagingRoot = posix.join(root, `.vitehub-workspace-${randomUUID()}`)
  const archive = posix.join(stagingRoot, "revision.tar.gz")
  const staging = posix.join(stagingRoot, "extracted")
  await host.files.mkdir(stagingRoot, { recursive: true })
  await host.files.write(archive, materialization.archive)
  await host.files.mkdir(staging, { recursive: true })
  try {
    const listed = await host.exec("tar", ["-tzf", archive], { signal })
    if (listed.code !== 0) {
      throw workspaceError(`[vitehub] Failed to inspect Workspace revision ${materialization.revision}: ${listed.stderr || "tar failed"}`)
    }
    const unsafeMember = listed.stdout.split("\n").filter(Boolean).find((member) => {
      if (member.startsWith("/") || member.includes("\0")) return true
      return member.replace(/\/+$/, "").split("/").includes("..")
    })
    if (unsafeMember) {
      throw workspaceError(`[vitehub] Workspace revision archive contains an unsafe path: ${unsafeMember}.`)
    }
    const extracted = await host.exec("tar", ["-xzf", archive, "-C", staging], { signal })
    if (extracted.code !== 0) {
      throw workspaceError(`[vitehub] Failed to extract Workspace revision ${materialization.revision}: ${extracted.stderr || "tar failed"}`)
    }
    const roots = (await host.files.list(staging)).filter(entry => entry.type === "directory")
    if (roots.length !== 1) {
      throw workspaceError(`[vitehub] Workspace revision archive must contain one repository root.`)
    }
    const archiveRoot = normalizeSafeWorkspacePath(materialization.root, { allowEmpty: true, allowReserved: true })
    let source = roots[0]!.path
    let validSource = true
    for (const component of archiveRoot.split("/").filter(Boolean)) {
      source = posix.join(source, component)
      if ((await host.exec("test", ["-L", source], { signal })).code === 0) {
        throw workspaceError(`[vitehub] Workspace revision archive root must not contain symlinks: ${materialization.root}.`)
      }
      if ((await host.exec("test", ["-d", source], { signal })).code !== 0) {
        validSource = false
        break
      }
    }
    if (!validSource && materialization.files > 0) {
      throw workspaceError(`[vitehub] Workspace revision archive is missing ${materialization.root || "its repository root"}.`)
    }
    if (!validSource) return
    const paths = materialization.paths
    if (!paths) {
      const copied = await host.exec("cp", ["-a", `${source}/.`, root], { signal })
      if (copied.code !== 0) {
        throw workspaceError(`[vitehub] Failed to materialize Workspace revision ${materialization.revision}: ${copied.stderr || "copy failed"}`)
      }
    }
    else {
      for (const path of paths) {
        const selected = posix.join(source, path)
        if (!await host.files.exists(selected)) continue
        const destination = toHostPath(root, posix.dirname(path) === "." ? "" : posix.dirname(path))
        await host.files.mkdir(destination, { recursive: true })
        const copied = await host.exec("cp", ["-a", selected, destination], { signal })
        if (copied.code !== 0) {
          throw workspaceError(`[vitehub] Failed to materialize Workspace revision ${materialization.revision}: ${copied.stderr || "copy failed"}`)
        }
      }
    }
  }
  finally {
    await removeHostPath(host, root, stagingRoot, true)
  }
}

async function sanitizeHostSymlinks(host: WorkspaceSessionHost, root: string) {
  const symlinks = (await listHostEntries(host, root, "", true)).filter(isGitSymlinkEntry)
  for (const entry of symlinks) {
    const path = toHostPath(root, entry.path)
    const target = await readHostSymlinkTarget(host, root, path)
    if (isSafeHostSymlink(root, entry.path, target)) continue
    await host.files.remove(path, { recursive: false })
    await host.files.write(path, contentToBytes(target))
  }
}

async function materializeWorkspace(
  workspace: Workspace,
  host: WorkspaceSessionHost,
  root: string,
  options?: WorkspaceSessionOptions,
  useRevisionMaterializer = true,
) {
  const abortSignal = options?.abortSignal
  abortSignal?.throwIfAborted()
  const paths = normalizeSessionPaths(options)
  const materializer = useRevisionMaterializer ? resolveWorkspaceRevisionMaterializer(workspace) : undefined
  const revision = materializer
    ? await withWorkspaceProgress(options?.onProgress, {
        data: { paths: paths ?? null },
        id: "workspace.prepare.revision",
        label: "Resolving workspace revision",
      }, async () => await materializer.materializeRevision({
        abortSignal: options?.abortSignal,
        paths,
      }))
    : undefined
  await withWorkspaceProgress(options?.onProgress, {
    id: "workspace.prepare.reset-sandbox",
    label: "Resetting sandbox workspace",
  }, async () => await resetHostWorkspaceRoot(host, root))
  abortSignal?.throwIfAborted()
  if (revision?.archive) {
    await withWorkspaceProgress(options?.onProgress, {
      data: {
        bytes: revision.archive.byteLength,
        files: revision.files,
        revision: revision.revision,
      },
      id: "workspace.prepare.extract-archive",
      label: "Extracting workspace revision",
    }, async () => await extractRevisionArchive(host, root, { ...revision, archive: revision.archive! }, options?.abortSignal))
    abortSignal?.throwIfAborted()
    await Promise.all([
      removeHostPath(host, root, toHostPath(root, ".git"), true),
      removeHostPath(host, root, toHostPath(root, ".vitehub"), true),
    ])
    abortSignal?.throwIfAborted()
    await sanitizeHostSymlinks(host, root)
    abortSignal?.throwIfAborted()
    const snapshot = await snapshotHost(host, root, "host-open")
    abortSignal?.throwIfAborted()
    return { revision: revision.revision, snapshot }
  }
  const entries = await withWorkspaceProgress(options?.onProgress, {
    data: { paths: paths ?? null },
    id: "workspace.prepare.entries",
    label: "Resolving workspace entries",
  }, async () => await sessionEntries(workspace, options))
  const symlinks = new Set(entries.filter(isGitSymlinkEntry).map(entry => entry.path))
  const nested = entries.find(entry => hasSymlinkParent(entry.path, symlinks))
  if (nested)
    throw workspaceError(`[vitehub] Workspace path crosses a symlink parent: ${nested.path}.`)
  for (const entry of entries.filter(entry => entry.type === "directory")) {
    abortSignal?.throwIfAborted()
    await host.files.mkdir(toHostPath(root, entry.path), { recursive: true })
    abortSignal?.throwIfAborted()
  }
  await withWorkspaceProgress(options?.onProgress, {
    data: {
      bytes: entries.reduce((total, entry) => total + (entry.size || 0), 0),
      files: entries.filter(entry => entry.type === "file").length,
    },
    id: "workspace.prepare.read-files",
    label: "Reading workspace files",
  }, async () => {
    abortSignal?.throwIfAborted()
    for (const entry of entries) {
      abortSignal?.throwIfAborted()
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
      abortSignal?.throwIfAborted()
    }
  })
  if (revision && await materializer?.currentRevision({ abortSignal: options?.abortSignal }) !== revision.revision) {
    throw workspaceConflict(`[vitehub] Workspace revision changed while this Session materialized: ${revision.revision}.`)
  }
  return { revision: revision?.revision, snapshot: await snapshotHost(host, root, "host-open") }
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
  return await workspace.snapshot({ name: message || "host-commit" })
}

export async function createHostedWorkspaceSession(
  workspace: Workspace,
  options: WorkspaceSessionOptions & { host: WorkspaceSessionHost },
): Promise<WorkspaceSession> {
  const host = options.host
  let executionAuthority
  try {
    executionAuthority = normalizeExecutionAuthority(host.executionAuthority)
  }
  catch {
    throw new TypeError("[vitehub] Workspace session host must declare executionAuthority.")
  }
  const root = normalizeTarget(options.target)
  const sessionPaths = normalizeSessionPaths(options)
  const excludedWriteBackPaths = [
    ".agent-runs",
    ".git",
    ".vitehub",
    ...(options.writeBack?.exclude || []).map(path => normalizeSafeWorkspacePath(path, { allowReserved: true })),
  ]
  let closed = false
  const existingExcludedState = await captureExcludedHostState(host, root, excludedWriteBackPaths)
  let attachedState = options.attach ? await captureHostState(host, root, "host-attach") : undefined
  let materialization: { revision?: string, snapshot: WorkspaceSnapshot }
  let materializedExcludedState: Awaited<ReturnType<typeof captureExcludedHostState>> | undefined
  try {
    materialization = attachedState
      ? { snapshot: attachedState.snapshot }
      : await materializeWorkspace(workspace, host, root, options)
    if (!attachedState)
      materializedExcludedState = await captureExcludedHostState(host, root, excludedWriteBackPaths)
  }
  catch (error) {
    if (attachedState) throw error
    try {
      host.detachAbortSignal?.()
      await materializeWorkspace(workspace, host, root, {
        ...options,
        abortSignal: undefined,
        onProgress: undefined,
      }, false)
      await restoreExcludedHostState(host, root, excludedWriteBackPaths, existingExcludedState)
    }
    catch (restoreError) {
      throw new AggregateError([error, restoreError], "[vitehub] Workspace Session setup and excluded-state restoration failed.")
    }
    throw error
  }
  let baseline = materialization.snapshot
  let baseRevision = materialization.revision
  const excludedState = attachedState
    ? existingExcludedState
    : mergeExcludedHostState(
        existingExcludedState,
        materializedExcludedState!,
        excludedWriteBackPaths,
      )
  const mediaTypes = new Map<string, string>()

  function assertOpen() {
    if (closed) throw workspaceError("[vitehub] Workspace host session is already closed.")
  }

  async function currentDiff() {
    assertOpen()
    return filterWriteBackDiff(diffSnapshots(baseline, await snapshotHost(host, root)), excludedWriteBackPaths)
  }

  return {
    executionAuthority,
    async readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, readOptions?: TOptions): Promise<ReadFileResult<TOptions>> {
      assertOpen()
      const target = toHostPath(root, assertPathInSessionScope(normalizeReadableSessionPath(path), sessionPaths, { masked: true }))
      const file = await readHostFile(host, root, target)
      if (!file) throw workspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
      return decodeFile(file.content, readOptions)
    },
    async writeFile(path: string, content: WorkspaceContent, writeOptions?: WorkspaceSessionWriteFileOptions) {
      assertOpen()
      const target = toHostPath(root, assertPathInSessionScope(normalizeSafeWorkspacePath(path), sessionPaths))
      await assertNoHostSymlinkParent(host, root, target)
      await ensureHostParent(host, target)
      await removeHostPath(host, root, target, true)
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
      await removeHostPath(host, root, target, Boolean(rmOptions?.recursive))
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
      const revisionMaterializer = resolveWorkspaceRevisionMaterializer(workspace)
      await withWorkspacePublication(revisionMaterializer || workspace, async () => {
        if (baseRevision && await revisionMaterializer?.currentRevision({ abortSignal: options.abortSignal }) !== baseRevision) {
          throw workspaceConflict(`[vitehub] Workspace revision changed after this Session materialized: ${baseRevision}.`)
        }
        try {
          await commitHostChanges(host, root, workspace, diff, mediaTypes, commitOptions?.message)
        }
        catch (error) {
          if (baseRevision) {
            try {
              await workspace.rebase({ takeRemote: diff.entries.map(entry => entry.path) })
            }
            catch (rollbackError) {
              throw new AggregateError([error, rollbackError], "[vitehub] Workspace publication and rollback failed.")
            }
          }
          throw error
        }
        if (baseRevision) {
          baseRevision = await revisionMaterializer!.currentRevision({
            refresh: false,
          })
        }
        if (options.attach) {
          attachedState = await captureHostState(host, root, commitOptions?.message || "host-commit")
          baseline = attachedState.snapshot
        }
        else baseline = await snapshotHost(host, root, commitOptions?.message || "host-commit")
      })
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
      host.detachAbortSignal?.()
      await ensureHostWorkspaceRoot(host, root)
      let diff: WorkspaceDiff | undefined
      if (options.attach && attachedState) {
        const attachedDiff = filterSessionDiff(diffSnapshots(baseline, await snapshotHost(host, root)), sessionPaths)
        let attachedRestoreError: unknown
        try {
          await restoreAttachedHost(host, root, attachedDiff, attachedState)
        }
        catch (error) {
          attachedRestoreError = error
        }
        try {
          await restoreExcludedHostState(host, root, excludedWriteBackPaths, excludedState)
        }
        catch (excludedError) {
          if (attachedRestoreError) {
            throw new AggregateError([attachedRestoreError, excludedError], "[vitehub] Attached Workspace Session restoration and excluded-state restoration failed.")
          }
          throw excludedError
        }
        if (attachedRestoreError) throw attachedRestoreError
      }
      else {
        diff = await currentDiff()
      }
      let restoreError: unknown
      try {
        if (diff?.entries.length) {
          await materializeWorkspace(workspace, host, root, {
            ...options,
            abortSignal: undefined,
            onProgress: undefined,
          })
        }
      }
      catch (error) {
        restoreError = error
      }
      try {
        if (!options.attach) await restoreExcludedHostState(host, root, excludedWriteBackPaths, excludedState)
      }
      catch (excludedError) {
        if (restoreError) {
          throw new AggregateError([restoreError, excludedError], "[vitehub] Workspace Session restoration and excluded-state restoration failed.")
        }
        throw excludedError
      }
      if (restoreError) throw restoreError
      closed = true
    },
  }
}
