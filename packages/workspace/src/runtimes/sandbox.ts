import { posix } from "node:path"

import { WorkspaceError } from "../errors.ts"
import { contentToBytes, decodeFile, normalizeSafeWorkspacePath, normalizeWorkspacePath, sha256 } from "../path.ts"
import { createSnapshotFromEntries, diffSnapshots } from "../stores/utils.ts"

import type {
  ExecOptions,
  ExecResult,
  ReadFileOptions,
  ReadFileResult,
  Workspace,
  WorkspaceContent,
  WorkspaceDefinition,
  WorkspaceDiff,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceSearchHit,
  WorkspaceSession,
  WorkspaceStore,
  WriteFileOptions,
} from "../types.ts"

type SandboxClient = Awaited<ReturnType<typeof import("@vitehub/sandbox").createSandboxWithConfig>>
type SandboxFileEntry = { path: string, size?: number, type: "file" | "directory" }

const sandboxCwd = "/workspace"

function unsupportedExec(): never {
  throw new WorkspaceError("[vitehub] Workspace does not configure an executable runtime. Set `runtime: 'sandbox'` in the workspace definition.")
}

function commandLabel(command: string, args: string[]) {
  return args.length ? `${command} ${args.join(" ")}` : command
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

function toText(content: WorkspaceContent) {
  return typeof content === "string" ? content : new TextDecoder().decode(content)
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
    content: await sandbox.readFile(path),
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
    const content = await sandbox.readFile(toSandboxPath(entry.path))
    return {
      ...entry,
      digest: await sha256(content),
      size: contentToBytes(content).byteLength,
    }
  }))
  return await createSnapshotFromEntries(files, name)
}

async function materializeWorkspace(workspace: Workspace, sandbox: SandboxClient, store: WorkspaceStore) {
  await sandbox.mkdir(sandboxCwd, { recursive: true })
  const entries = (await workspace.glob("**/*")).filter(entry => entry.type === "file")
  for (const entry of entries) {
    const content = await workspace.readFile(entry.path, { encoding: "binary" })
    const target = toSandboxPath(entry.path)
    await ensureSandboxParent(sandbox, target)
    await sandbox.writeFile(target, toText(content))
  }
  return await createSnapshotFromEntries(await store.list("", { recursive: true }), "sandbox-open")
}

async function commitSandboxChanges(
  sandbox: SandboxClient,
  store: WorkspaceStore,
  diff: WorkspaceDiff,
) {
  for (const entry of diff.entries) {
    if (entry.after?.type === "directory") {
      await store.mkdir(entry.path, { recursive: true })
      continue
    }
    if (entry.type === "removed") {
      await store.rm(entry.path, { force: true, recursive: true })
      continue
    }
    if (entry.after?.type === "file") {
      const file = await readSandboxFile(sandbox, toSandboxPath(entry.path))
      if (file)
        await store.writeFile(entry.path, file)
    }
  }
  await store.snapshot({ name: "sandbox-commit" })
}

export function createBasicWorkspaceSession(workspace: Workspace): WorkspaceSession {
  return {
    readFile: workspace.readFile,
    writeFile: workspace.writeFile,
    list: workspace.list,
    glob: workspace.glob,
    search: workspace.search,
    diff: () => workspace.diff(),
    async commit(options) {
      await workspace.snapshot({ name: options?.message || "session-commit" })
    },
    async exec(command: string, args: string[] = [], _options?: ExecOptions): Promise<ExecResult> {
      unsupportedExec()
    },
    async close() {},
  }
}

export async function createSandboxWorkspaceSession(
  definition: WorkspaceDefinition,
  workspace: Workspace,
  store: WorkspaceStore,
): Promise<WorkspaceSession> {
  const sandboxPackage = await import("@vitehub/sandbox").catch((error) => {
    throw new WorkspaceError(`[vitehub] Sandbox workspace runtime requires @vitehub/sandbox. ${error instanceof Error ? error.message : String(error)}`)
  })
  const sandboxConfig = (await import("@vitehub/sandbox/runtime/state")).getSandboxRuntimeConfig()

  if (!sandboxConfig) {
    throw new WorkspaceError("[vitehub] Workspace runtime `sandbox` requires app-level `sandbox` config.")
  }

  const sandbox = await sandboxPackage.createSandboxWithConfig(sandboxConfig)
  let baseline = await materializeWorkspace(workspace, sandbox, store)
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
    async writeFile(path: string, content: WorkspaceContent, _options?: WriteFileOptions) {
      assertOpen()
      const target = toSandboxPath(path)
      await ensureSandboxParent(sandbox, target)
      await sandbox.writeFile(target, toText(content))
    },
    async list(path = "", options = {}) {
      assertOpen()
      return await listSandboxEntries(sandbox, path, options.recursive)
    },
    async glob(pattern, _options = {}) {
      assertOpen()
      const patterns = Array.isArray(pattern) ? pattern : [pattern]
      const { matchesAny } = await import("../path.ts")
      return (await listSandboxEntries(sandbox, "", true))
        .filter(entry => entry.type === "file" && patterns.some(item => matchesAny(entry.path, item)))
    },
    async search(query) {
      assertOpen()
      const { searchText } = await import("../search.ts")
      const limit = query.limit ?? 100
      const hits: WorkspaceSearchHit[] = []
      for (const entry of (await listSandboxEntries(sandbox, "", true)).filter(item => item.type === "file")) {
        if (query.paths?.length && !query.paths.some(path => entry.path === path || entry.path.startsWith(`${path}/`))) continue
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
      await commitSandboxChanges(sandbox, store, diff)
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
