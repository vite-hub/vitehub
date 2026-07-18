import { posix } from "node:path"
import { Effect } from "effect"

import { WorkspaceError } from "../core/errors.ts"
import { contentToBytes, decodeFile, normalizeSafeWorkspacePath, normalizeWorkspacePath, sha256 } from "../core/path.ts"
import { runWorkspaceEffect, tryWorkspacePromise } from "../internal/effect-runtime.ts"
import { loadWorkspaceSandboxModule, loadWorkspaceSandboxRuntimeStateModule } from "../runtime/dependency-loaders.ts"
import { createSnapshotFromEntries, diffSnapshots } from "../storage/utils.ts"
import { openSandboxWorkspaceScope } from "./sandbox-scope.ts"
import { assertDiffInsideSessionPaths, assertPathInSessionScope, filterSessionDiff, filterSessionEntries, isMissingWorkspacePathError, scopedSearchQuery } from "./scope.ts"

import type {
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
  WorkspaceSessionOptions,
  WriteFileOptions,
} from "../core/types.ts"

type SandboxClient = Awaited<ReturnType<typeof import("@vite-hub/sandbox").createSandboxWithConfig>>
type SandboxFileEntry = { path: string, size?: number, type: "directory" | "file" | "symlink" }
type SandboxPackage = typeof import("@vite-hub/sandbox")
type SandboxRuntimeStateModule = typeof import("@vite-hub/sandbox/runtime/state")

const sandboxCwd = "/workspace"

function normalizeSearchRoot(path: string) {
  const normalized = posix.normalize(path.replace(/\\/g, "/"))
  return normalized === "." ? "" : normalizeSafeWorkspacePath(normalized, { allowEmpty: true })
}

function toSandboxPath(path = "") {
  const normalized = normalizeSafeWorkspacePath(path, { allowEmpty: true })
  return normalized ? posix.join(sandboxCwd, normalized) : sandboxCwd
}

function fromSandboxPath(path: string) {
  const normalizedRoot = sandboxCwd.replace(/\/+$/, "")
  const normalizedPath = path.replace(/\/+$/, "")
  if (normalizedPath === normalizedRoot) return ""
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return normalizeWorkspacePath(normalizedPath)
  return normalizeWorkspacePath(normalizedPath.slice(normalizedRoot.length + 1))
}

function isGitSymlinkEntry(entry: WorkspaceEntry): boolean {
  return entry.metadata?.gitMode === "120000"
}

function toWorkspaceEntry(entry: SandboxFileEntry): WorkspaceEntry {
  return {
    metadata: entry.type === "symlink" ? { gitMode: "120000" } : undefined,
    path: fromSandboxPath(entry.path),
    size: entry.size,
    type: entry.type === "directory" ? "directory" : "file",
  }
}

async function ensureSandboxParent(sandbox: SandboxClient, path: string) {
  const parent = posix.dirname(path)
  if (parent && parent !== "." && parent !== "/")
    await sandbox.mkdir(parent, { recursive: true })
}

async function readSandboxSymlinkTarget(sandbox: SandboxClient, path: string): Promise<string> {
  const result = await sandbox.exec("readlink", [path])
  if (!result.ok)
    throw new WorkspaceError(`[vitehub] Failed to read sandbox symlink: ${path}. ${result.stderr || "readlink failed"}`)
  return result.stdout.replace(/\n$/, "")
}

async function writeSandboxSymlink(sandbox: SandboxClient, path: string, target: string) {
  await sandbox.deleteFile(path).catch(() => undefined)
  const result = await sandbox.exec("ln", ["-s", target, path])
  if (!result.ok)
    throw new WorkspaceError(`[vitehub] Failed to create sandbox symlink: ${path}. ${result.stderr || "ln failed"}`)
}

async function readSandboxFile(sandbox: SandboxClient, path: string): Promise<WorkspaceFile | undefined> {
  if (!await sandbox.exists(path))
    return undefined
  return {
    content: await sandbox.readFile(path, { encoding: "binary" }),
    path: fromSandboxPath(path),
  }
}

async function listSandboxEntries(sandbox: SandboxClient, path = "", recursive = false): Promise<WorkspaceEntry[]> {
  const root = toSandboxPath(path)
  const entries = await sandbox.listFiles(root, { recursive }) as SandboxFileEntry[]
  return entries
    .map(toWorkspaceEntry)
    .filter(entry => entry.path)
    .sort((left, right) => left.path.localeCompare(right.path))
}

async function snapshotSandbox(sandbox: SandboxClient, name?: string) {
  const entries = await listSandboxEntries(sandbox, "", true)
  const files = await runWorkspaceEffect(Effect.forEach(entries, entry => {
    if (entry.type !== "file") return Effect.succeed(entry)
    return tryWorkspacePromise("Workspace.Sandbox.snapshot.read", async () => {
      const content = isGitSymlinkEntry(entry)
        ? await readSandboxSymlinkTarget(sandbox, toSandboxPath(entry.path))
        : await sandbox.readFile(toSandboxPath(entry.path), { encoding: "binary" })
      return {
        ...entry,
        digest: await sha256(content),
        size: contentToBytes(content).byteLength,
      }
    })
  }, { concurrency: 16 }))
  return await createSnapshotFromEntries(files, name)
}

async function resetSandboxWorkspaceRoot(sandbox: SandboxClient) {
  const result = await sandbox.exec("rm", ["-rf", sandboxCwd])
  if (!result.ok)
    throw new WorkspaceError(`[vitehub] Failed to reset sandbox workspace root: ${result.stderr || "rm failed"}`)
  await sandbox.mkdir(sandboxCwd, { recursive: true })
}

function normalizeSessionPaths(options?: WorkspaceSessionOptions): string[] | undefined {
  const paths = [...new Set((options?.paths || []).map(path => normalizeSafeWorkspacePath(path, { allowEmpty: true })))]
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

async function materializeWorkspace(workspace: Workspace, sandbox: SandboxClient, options?: WorkspaceSessionOptions) {
  await resetSandboxWorkspaceRoot(sandbox)
  const entries = await sessionEntries(workspace, options)
  for (const entry of entries.filter(entry => entry.type === "directory"))
    await sandbox.mkdir(toSandboxPath(entry.path), { recursive: true })
  for (const entry of entries) {
    if (entry.type !== "file") continue
    const target = toSandboxPath(entry.path)
    await ensureSandboxParent(sandbox, target)
    if (isGitSymlinkEntry(entry)) {
      const symlinkTarget = typeof entry.metadata?.symlinkTarget === "string"
        ? entry.metadata.symlinkTarget
        : new TextDecoder().decode(contentToBytes(await workspace.readFile(entry.path, { encoding: "binary" })))
      await writeSandboxSymlink(sandbox, target, symlinkTarget)
    }
    else {
      const content = await workspace.readFile(entry.path, { encoding: "binary" })
      await sandbox.writeFile(target, content)
    }
  }
  return await snapshotSandbox(sandbox, "sandbox-open")
}

async function commitSandboxChanges(
  sandbox: SandboxClient,
  workspace: Workspace,
  diff: WorkspaceDiff,
  mediaTypes: Map<string, string>,
) {
  for (const entry of diff.entries) {
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
      const target = toSandboxPath(entry.path)
      const file = entry.after.metadata?.gitMode === "120000"
        ? { content: await readSandboxSymlinkTarget(sandbox, target), metadata: entry.after.metadata, path: entry.path }
        : await readSandboxFile(sandbox, target)
      if (file)
        await workspace.writeFile(entry.path, file.content, { mediaType: file.mediaType || mediaTypes.get(entry.path) || before?.mediaType, metadata: file.metadata })
    }
  }
  await workspace.snapshot({ name: "sandbox-commit" })
}

export async function createSandboxWorkspaceSession(
  definition: WorkspaceDefinition,
  workspace: Workspace,
  options?: WorkspaceSessionOptions,
): Promise<WorkspaceSession> {
  const sandboxPackage = await loadWorkspaceSandboxModule().catch((error) => {
    throw new WorkspaceError(`[vitehub] Sandbox workspace runtime requires @vite-hub/sandbox. ${error instanceof Error ? error.message : String(error)}`)
  }) as SandboxPackage
  const sandboxConfig = (await loadWorkspaceSandboxRuntimeStateModule() as SandboxRuntimeStateModule).getSandboxRuntimeConfig()

  if (!sandboxConfig) {
    throw new WorkspaceError("[vitehub] Workspace runtime `sandbox` requires app-level `sandbox` config.")
  }

  const sessionPaths = normalizeSessionPaths(options)
  const sandboxScope = await openSandboxWorkspaceScope(
    () => sandboxPackage.createSandboxWithConfig(sandboxConfig),
    sandbox => materializeWorkspace(workspace, sandbox, options),
  )
  const sandbox = sandboxScope.resource
  let baseline = sandboxScope.setup
  const mediaTypes = new Map<string, string>()

  function assertOpen() {
    if (sandboxScope.isClosed())
      throw new WorkspaceError("[vitehub] Workspace sandbox session is already closed.")
  }

  async function currentDiff() {
    assertOpen()
    return diffSnapshots(baseline, await snapshotSandbox(sandbox))
  }

  return {
    async readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, options?: TOptions): Promise<ReadFileResult<TOptions>> {
      assertOpen()
      const file = await readSandboxFile(sandbox, toSandboxPath(assertPathInSessionScope(normalizeSafeWorkspacePath(path), sessionPaths, { masked: true })))
      if (!file) throw new WorkspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
      return decodeFile(file.content, options)
    },
    async writeFile(path: string, content: WorkspaceContent, options?: WriteFileOptions) {
      assertOpen()
      const target = toSandboxPath(assertPathInSessionScope(normalizeSafeWorkspacePath(path), sessionPaths))
      await ensureSandboxParent(sandbox, target)
      await sandbox.deleteFile(target).catch(() => undefined)
      if (options?.metadata?.gitMode === "120000")
        await writeSandboxSymlink(sandbox, target, new TextDecoder().decode(contentToBytes(content)))
      else
        await sandbox.writeFile(target, content)
      const workspacePath = fromSandboxPath(target)
      if (options?.mediaType)
        mediaTypes.set(workspacePath, options.mediaType)
      else
        mediaTypes.delete(workspacePath)
    },
    async mkdir(path: string, options = {}) {
      assertOpen()
      await sandbox.mkdir(toSandboxPath(assertPathInSessionScope(normalizeSafeWorkspacePath(path, { allowEmpty: true }), sessionPaths, { mkdir: true })), { recursive: options.recursive })
    },
    async rm(path: string, _options?: RmOptions) {
      assertOpen()
      const workspacePath = assertPathInSessionScope(normalizeSafeWorkspacePath(path), sessionPaths)
      await sandbox.deleteFile(toSandboxPath(workspacePath))
      mediaTypes.delete(normalizeWorkspacePath(workspacePath))
    },
    async list(path = "", options = {}) {
      assertOpen()
      return filterSessionEntries(await listSandboxEntries(sandbox, path, options.recursive), sessionPaths)
    },
    async glob(pattern, _options = {}) {
      assertOpen()
      const patterns = Array.isArray(pattern) ? pattern : [pattern]
      const { matchesAny } = await import("../core/path.ts")
      return filterSessionEntries(await listSandboxEntries(sandbox, "", true), sessionPaths)
        .filter(entry => entry.type === "file" && patterns.some(item => matchesAny(entry.path, item)))
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
      for (const entry of filterSessionEntries(await listSandboxEntries(sandbox, "", true), sessionPaths).filter(item => item.type === "file")) {
        if (scopedSearchRoots.length && !scopedSearchRoots.some(path => entry.path === path || entry.path.startsWith(`${path}/`))) continue
        const text = await sandbox.readFile(toSandboxPath(entry.path))
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
      if (!diff.entries.length) return
      assertDiffInsideSessionPaths(diff, sessionPaths)
      await commitSandboxChanges(sandbox, workspace, diff, mediaTypes)
      baseline = await snapshotSandbox(sandbox, options?.message || "sandbox-commit")
    },
    async exec(command, args = [], options = {}) {
      assertOpen()
      const result = await sandbox.exec(command, args, {
        cwd: options.cwd || sandboxCwd,
        env: options.env,
        timeout: options.timeout,
      })
      return {
        args,
        command,
        exitCode: result.code ?? 0,
        stderr: result.stderr,
        stdout: result.stdout,
      }
    },
    async close() {
      await sandboxScope.close()
    },
  }
}
