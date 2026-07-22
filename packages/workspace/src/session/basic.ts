import { workspaceError } from "../core/errors.ts"
import { decodeFile, matchesAny, normalizeSafeWorkspacePath } from "../core/path.ts"
import { searchText } from "../core/search.ts"
import { createMemoryWorkspaceStore } from "../storage/memory.ts"
import { assertDiffInsideSessionPaths, assertPathInSessionScope, filterSessionDiff, filterSessionEntries, scopedSearchQuery } from "./scope.ts"

import type { ExecOptions, ExecResult, MkdirOptions, ReadFileOptions, ReadFileResult, Workspace, WorkspaceSearchHit, WorkspaceSession, WorkspaceSessionOptions } from "../core/types.ts"

function unsupportedExec(): never {
  throw workspaceError("[vitehub] Workspace exec requires a Box session host. Pass the active Box session to workspace.startSession({ host }).")
}

function normalizeSessionPaths(options?: WorkspaceSessionOptions): string[] | undefined {
  const paths = [...new Set((options?.paths || []).map(path => normalizeSafeWorkspacePath(path, { allowEmpty: true, allowReserved: true })))]
  if (!paths.length || paths.includes("")) return undefined
  return paths.sort((left, right) => left.length - right.length || left.localeCompare(right))
}

function normalizeSessionPath(path = "", options: { allowEmpty?: boolean } = {}) {
  const normalized = path.replace(/\\/g, "/")
  return normalizeSafeWorkspacePath(normalized === "." ? "" : normalized, { allowEmpty: options.allowEmpty, allowReserved: true })
}

export async function createBasicWorkspaceSession(workspace: Workspace, options?: WorkspaceSessionOptions): Promise<WorkspaceSession> {
  const sessionPaths = normalizeSessionPaths(options)
  const overlay = createMemoryWorkspaceStore()
  const initialEntries = filterSessionEntries(await workspace.list("", { recursive: true }), sessionPaths)
  for (const entry of initialEntries.filter(entry => entry.type === "directory"))
    await overlay.mkdir(entry.path, { recursive: true })
  for (const entry of initialEntries.filter(entry => entry.type === "file")) {
    await overlay.writeFile(entry.path, {
      content: await workspace.readFile(entry.path, { encoding: "binary" }),
      mediaType: entry.mediaType,
      metadata: entry.metadata,
      path: entry.path,
    })
  }
  await overlay.snapshot({ name: "session-baseline" })

  return {
    async readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, readOptions?: TOptions): Promise<ReadFileResult<TOptions>> {
      const target = assertPathInSessionScope(normalizeSessionPath(path), sessionPaths, { masked: true })
      const file = await overlay.readFile(target)
      if (!file) throw workspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
      return decodeFile(file.content, readOptions)
    },
    async writeFile(path, content, writeOptions) {
      const target = assertPathInSessionScope(normalizeSessionPath(path), sessionPaths)
      await overlay.writeFile(target, { content, path: target, ...writeOptions })
    },
    async mkdir(path, mkdirOptions?: MkdirOptions) {
      await overlay.mkdir(assertPathInSessionScope(normalizeSessionPath(path, { allowEmpty: true }), sessionPaths, { mkdir: true }), mkdirOptions)
    },
    async rm(path, rmOptions) {
      await overlay.rm(assertPathInSessionScope(normalizeSessionPath(path), sessionPaths), rmOptions)
    },
    async list(path = "", listOptions = {}) {
      return filterSessionEntries(await overlay.list(normalizeSessionPath(path, { allowEmpty: true }), listOptions), sessionPaths)
    },
    async glob(pattern, globOptions) {
      const patterns = Array.isArray(pattern) ? pattern : [pattern]
      const cwd = normalizeSessionPath(globOptions?.cwd || "", { allowEmpty: true })
      return filterSessionEntries(await overlay.list("", { recursive: true }), sessionPaths)
        .filter((entry) => {
          if (entry.type !== "file") return false
          if (!cwd) return patterns.some(item => matchesAny(entry.path, item))
          if (!entry.path.startsWith(`${cwd}/`)) return false
          return patterns.some(item => matchesAny(entry.path.slice(cwd.length + 1), item))
        })
    },
    async search(query) {
      const scoped = scopedSearchQuery(query, sessionPaths, path => normalizeSessionPath(path, { allowEmpty: true }))
      if (!scoped) return []
      const roots = (scoped.paths?.length ? scoped.paths : [scoped.cwd || ""]).map(path => normalizeSessionPath(path, { allowEmpty: true }))
      const hits: WorkspaceSearchHit[] = []
      for (const entry of filterSessionEntries(await overlay.list("", { recursive: true }), sessionPaths).filter(entry => entry.type === "file")) {
        if (!roots.some(root => !root || entry.path === root || entry.path.startsWith(`${root}/`))) continue
        const file = await overlay.readFile(entry.path)
        if (!file) continue
        hits.push(...searchText(entry.path, decodeFile(file.content), { ...scoped, limit: (scoped.limit || 100) - hits.length }))
        if (hits.length >= (scoped.limit || 100)) break
      }
      return hits
    },
    async diff() {
      return filterSessionDiff(await overlay.diff(), sessionPaths)
    },
    async commit(commitOptions) {
      const diff = await overlay.diff()
      assertDiffInsideSessionPaths(diff, sessionPaths)
      assertDiffInsideSessionPaths(await workspace.diff(), sessionPaths)
      for (const entry of [...diff.entries].sort((left, right) => right.path.length - left.path.length)) {
        if (entry.type === "removed") await workspace.rm(entry.path, { force: true, recursive: true })
      }
      for (const entry of diff.entries) {
        if (!entry.after) continue
        if (entry.after.type === "directory") {
          if (entry.before?.type === "file") await workspace.rm(entry.path, { force: true })
          await workspace.mkdir(entry.path, { recursive: true })
          continue
        }
        if (entry.before?.type === "directory") await workspace.rm(entry.path, { force: true, recursive: true })
        const file = await overlay.readFile(entry.path)
        if (file) await workspace.writeFile(entry.path, file.content, { mediaType: file.mediaType, metadata: file.metadata })
      }
      await workspace.snapshot({ name: commitOptions?.message || "session-commit" })
      await overlay.snapshot({ name: commitOptions?.message || "session-commit" })
    },
    async exec(_command: string, _args: string[] = [], _options?: ExecOptions): Promise<ExecResult> {
      unsupportedExec()
    },
    async close() {},
  }
}
