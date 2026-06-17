import { posix } from "node:path"

import { WorkspaceError } from "../core/errors.ts"
import { contentToBytes, decodeFile, normalizeSafeWorkspacePath, normalizeWorkspacePath, sha256 } from "../core/path.ts"
import { createSnapshotFromEntries, diffSnapshots } from "../storage/utils.ts"

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
  WriteFileOptions,
} from "../core/types.ts"

type SandboxClient = Awaited<ReturnType<typeof import("@vite-hub/sandbox").createSandboxWithConfig>>
type SandboxFileEntry = { path: string, size?: number, type: "file" | "directory" }
type SandboxPackage = typeof import("@vite-hub/sandbox")
type SandboxRuntimeStateModule = typeof import("@vite-hub/sandbox/runtime/state")

const sandboxCwd = "/workspace"
const sandboxPackageSpecifier = "@vite-hub/sandbox"
const sandboxRuntimeStateSpecifier = "@vite-hub/sandbox/runtime/state"

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

function toWorkspaceEntry(entry: { path: string, size?: number, type: "file" | "directory" }): WorkspaceEntry {
  return {
    path: fromSandboxPath(entry.path),
    size: entry.size,
    type: entry.type,
  }
}

async function ensureSandboxParent(sandbox: SandboxClient, path: string) {
  const parent = posix.dirname(path)
  if (parent && parent !== "." && parent !== "/")
    await sandbox.mkdir(parent, { recursive: true })
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
  const files = await Promise.all(entries.map(async (entry) => {
    if (entry.type !== "file") return entry
    const content = await sandbox.readFile(toSandboxPath(entry.path), { encoding: "binary" })
    return {
      ...entry,
      digest: await sha256(content),
      size: contentToBytes(content).byteLength,
    }
  }))
  return await createSnapshotFromEntries(files, name)
}

async function resetSandboxWorkspaceRoot(sandbox: SandboxClient) {
  const result = await sandbox.exec("rm", ["-rf", sandboxCwd])
  if (!result.ok)
    throw new WorkspaceError(`[vitehub] Failed to reset sandbox workspace root: ${result.stderr || "rm failed"}`)
  await sandbox.mkdir(sandboxCwd, { recursive: true })
}

async function materializeWorkspace(workspace: Workspace, sandbox: SandboxClient) {
  await resetSandboxWorkspaceRoot(sandbox)
  const entries = await workspace.list("", { recursive: true })
  for (const entry of entries.filter(entry => entry.type === "directory"))
    await sandbox.mkdir(toSandboxPath(entry.path), { recursive: true })
  for (const entry of entries) {
    if (entry.type !== "file") continue
    const content = await workspace.readFile(entry.path, { encoding: "binary" })
    const target = toSandboxPath(entry.path)
    await ensureSandboxParent(sandbox, target)
    await sandbox.writeFile(target, content)
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
      const file = await readSandboxFile(sandbox, toSandboxPath(entry.path))
      if (file)
        await workspace.writeFile(entry.path, file.content, { mediaType: file.mediaType || mediaTypes.get(entry.path) || before?.mediaType })
    }
  }
  await workspace.snapshot({ name: "sandbox-commit" })
}

export async function createSandboxWorkspaceSession(
  definition: WorkspaceDefinition,
  workspace: Workspace,
): Promise<WorkspaceSession> {
  const sandboxPackage = await import(/* @vite-ignore */ sandboxPackageSpecifier).catch((error) => {
    throw new WorkspaceError(`[vitehub] Sandbox workspace runtime requires @vite-hub/sandbox. ${error instanceof Error ? error.message : String(error)}`)
  }) as SandboxPackage
  const sandboxConfig = (await import(/* @vite-ignore */ sandboxRuntimeStateSpecifier) as SandboxRuntimeStateModule).getSandboxRuntimeConfig()

  if (!sandboxConfig) {
    throw new WorkspaceError("[vitehub] Workspace runtime `sandbox` requires app-level `sandbox` config.")
  }

  const sandbox = await sandboxPackage.createSandboxWithConfig(sandboxConfig)
  let baseline = await materializeWorkspace(workspace, sandbox)
  const mediaTypes = new Map<string, string>()
  let closed = false

  function assertOpen() {
    if (closed)
      throw new WorkspaceError("[vitehub] Workspace sandbox session is already closed.")
  }

  async function currentDiff() {
    assertOpen()
    return diffSnapshots(baseline, await snapshotSandbox(sandbox))
  }

  return {
    async readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, options?: TOptions): Promise<ReadFileResult<TOptions>> {
      assertOpen()
      const file = await readSandboxFile(sandbox, toSandboxPath(path))
      if (!file) throw new WorkspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
      return decodeFile(file.content, options)
    },
    async writeFile(path: string, content: WorkspaceContent, options?: WriteFileOptions) {
      assertOpen()
      const target = toSandboxPath(path)
      await ensureSandboxParent(sandbox, target)
      await sandbox.writeFile(target, content)
      const workspacePath = fromSandboxPath(target)
      if (options?.mediaType)
        mediaTypes.set(workspacePath, options.mediaType)
      else
        mediaTypes.delete(workspacePath)
    },
    async rm(path: string, _options?: RmOptions) {
      assertOpen()
      await sandbox.deleteFile(toSandboxPath(path))
      mediaTypes.delete(normalizeWorkspacePath(path))
    },
    async list(path = "", options = {}) {
      assertOpen()
      return await listSandboxEntries(sandbox, path, options.recursive)
    },
    async glob(pattern, _options = {}) {
      assertOpen()
      const patterns = Array.isArray(pattern) ? pattern : [pattern]
      const { matchesAny } = await import("../core/path.ts")
      return (await listSandboxEntries(sandbox, "", true))
        .filter(entry => entry.type === "file" && patterns.some(item => matchesAny(entry.path, item)))
    },
    async search(query) {
      assertOpen()
      const { searchText } = await import("../core/search.ts")
      const searchRoots = [...new Set((query.paths?.length ? query.paths : [query.cwd || ""]).map(normalizeSearchRoot))]
      const scopedSearchRoots = searchRoots.filter(Boolean)
      const limit = query.limit ?? 100
      const hits: WorkspaceSearchHit[] = []
      for (const entry of (await listSandboxEntries(sandbox, "", true)).filter(item => item.type === "file")) {
        if (scopedSearchRoots.length && !scopedSearchRoots.some(path => entry.path === path || entry.path.startsWith(`${path}/`))) continue
        const text = await sandbox.readFile(toSandboxPath(entry.path))
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
      if (closed) return
      closed = true
      if (sandbox.provider === "vercel")
        await sandbox.stop().catch(() => {})
    },
  }
}
