import { WorkspaceError } from "../core/errors.ts"
import { normalizeSafeWorkspacePath } from "../core/path.ts"
import { assertDiffInsideSessionPaths, assertPathInSessionScope, filterSessionDiff, filterSessionEntries, scopedSearchQuery } from "./scope.ts"

import type { ExecOptions, ExecResult, MkdirOptions, Workspace, WorkspaceSession, WorkspaceSessionOptions } from "../core/types.ts"

function unsupportedExec(): never {
  throw new WorkspaceError("[vitehub] Workspace exec requires an executable runtime. Set `runtime: 'sandbox'` for hosted or untrusted execution, set `runtime: 'trusted-host'` for trusted local development and tests, or avoid session.exec().")
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

export function createBasicWorkspaceSession(workspace: Workspace, options?: WorkspaceSessionOptions): WorkspaceSession {
  const sessionPaths = normalizeSessionPaths(options)
  return {
    async readFile(path, options) {
      return await workspace.readFile(assertPathInSessionScope(normalizeSessionPath(path), sessionPaths, { masked: true }), options)
    },
    async writeFile(path, content, options) {
      await workspace.writeFile(assertPathInSessionScope(normalizeSessionPath(path), sessionPaths), content, options)
    },
    async mkdir(path, options?: MkdirOptions) {
      await workspace.mkdir(assertPathInSessionScope(normalizeSessionPath(path, { allowEmpty: true }), sessionPaths, { mkdir: true }), options)
    },
    async rm(path, options) {
      await workspace.rm(assertPathInSessionScope(normalizeSessionPath(path), sessionPaths), options)
    },
    async list(path = "", options = {}) {
      return filterSessionEntries(await workspace.list(normalizeSessionPath(path, { allowEmpty: true }), options), sessionPaths)
    },
    async glob(pattern, options) {
      return filterSessionEntries(await workspace.glob(pattern, options), sessionPaths)
    },
    async search(query) {
      const scoped = scopedSearchQuery(query, sessionPaths, path => normalizeSessionPath(path, { allowEmpty: true }))
      return scoped ? await workspace.search(scoped) : []
    },
    async diff() {
      return filterSessionDiff(await workspace.diff(), sessionPaths)
    },
    async commit(options) {
      assertDiffInsideSessionPaths(await workspace.diff(), sessionPaths)
      await workspace.snapshot({ name: options?.message || "session-commit" })
    },
    async exec(_command: string, _args: string[] = [], _options?: ExecOptions): Promise<ExecResult> {
      unsupportedExec()
    },
    async close() {},
  }
}
