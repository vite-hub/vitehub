import { lookup } from "mrmime"

import { workspaceError } from "../../core/errors.ts"
import {
  historyConflict,
  normalizeHistoryPath,
  normalizeHistoryRef,
} from "../../core/history.ts"
import {
  contentToBytes,
  decodeFile,
  isExcludedWorkspacePath,
  normalizeSafeWorkspacePath,
} from "../../core/path.ts"
import { workspaceErrorDiagnostics } from "../../error-diagnostics.ts"
import {
  commitGitHubChanges,
  gitBlobSha,
  githubRequestStatus,
  joinGitPath,
  readGitHubBranchState,
  readGitHubRawFile,
  requestGitHubJsonResponse,
  splitGitHubRepository,
  type GitHubTreeEntry,
  type GitHubWorkspaceOptions,
} from "./shared.ts"

import type {
  ListOptions,
  ReadFileOptions,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceHistoryListOptions,
  WorkspaceHistoryListResult,
  WorkspaceHistoryRef,
  WorkspaceRevision,
  WorkspaceRevisionView,
  WorkspaceStoreHistory,
  WorkspaceStoreHistoryCommitOptions,
} from "../../core/types.ts"

interface GitHubHistoryOptions extends GitHubWorkspaceOptions {
  repository: string
  root: string
  token: string
  branch: string
}

interface GitHubCommit {
  author?: GitHubPerson
  authorLogin?: string
  committer?: GitHubPerson
  committerLogin?: string
  htmlUrl?: string
  message: string
  parents: string[]
  sha: string
  tree: string
}

interface GitHubPerson {
  date?: string
  email?: string
  name?: string
}

interface GitHubHistoryEntry {
  mode?: string
  path: string
  sha: string
  size: number
}

interface GitHubBranch {
  commit: string
  name: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : nonEmptyString(value) ? value : undefined
}

function malformed(description: string): never {
  throw workspaceError(`[vitehub] GitHub workspace returned a malformed ${description} response.`)
}

function parseTreeEntry(value: unknown): GitHubTreeEntry {
  if (!isRecord(value) || !nonEmptyString(value.path) || !nonEmptyString(value.sha) || !nonEmptyString(value.type)) malformed("tree")
  if (value.mode !== undefined && typeof value.mode !== "string") malformed("tree")
  if (value.size !== undefined && (typeof value.size !== "number" || !Number.isInteger(value.size) || value.size < 0)) malformed("tree")
  return {
    path: value.path,
    sha: value.sha,
    type: value.type,
    ...(value.mode === undefined ? {} : { mode: value.mode }),
    ...(value.size === undefined ? {} : { size: value.size }),
  }
}

function parseTree(value: unknown): { entries: GitHubTreeEntry[], truncated: boolean } {
  if (!isRecord(value) || !Array.isArray(value.tree) || value.tree.some(entry => {
    try {
      parseTreeEntry(entry)
      return false
    }
    catch {
      return true
    }
  })) malformed("tree")
  return { entries: value.tree.map(parseTreeEntry), truncated: value.truncated === true }
}

function parsePerson(value: unknown): GitHubPerson | undefined {
  if (value === null || value === undefined) return undefined
  if (!isRecord(value)) malformed("commit")
  if (value.name !== undefined && typeof value.name !== "string") malformed("commit")
  if (value.email !== undefined && typeof value.email !== "string") malformed("commit")
  if (value.date !== undefined && typeof value.date !== "string") malformed("commit")
  return {
    ...(value.date === undefined ? {} : { date: value.date }),
    ...(value.email === undefined ? {} : { email: value.email }),
    ...(value.name === undefined ? {} : { name: value.name }),
  }
}

function parseLogin(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (!isRecord(value)) malformed("commit")
  if (value.login !== undefined && !nonEmptyString(value.login)) malformed("commit")
  return value.login
}

function parseCommit(value: unknown): GitHubCommit {
  if (!isRecord(value) || !nonEmptyString(value.sha) || !isRecord(value.commit)) malformed("commit")
  const commit = value.commit
  if (!nonEmptyString(commit.message) || !isRecord(commit.tree) || !nonEmptyString(commit.tree.sha)) malformed("commit")
  if (commit.author !== undefined && commit.author !== null && !isRecord(commit.author)) malformed("commit")
  if (commit.committer !== undefined && commit.committer !== null && !isRecord(commit.committer)) malformed("commit")
  if (value.parents !== undefined && (!Array.isArray(value.parents) || value.parents.some(parent => !isRecord(parent) || !nonEmptyString(parent.sha)))) malformed("commit")
  if (value.html_url !== undefined && typeof value.html_url !== "string") malformed("commit")
  const authorLogin = parseLogin(value.author)
  const committerLogin = parseLogin(value.committer)
  const author = parsePerson(commit.author)
  const committer = parsePerson(commit.committer)
  const createdAt = author?.date || committer?.date
  if (!createdAt) malformed("commit")
  return {
    ...(author ? { author } : {}),
    ...(authorLogin ? { authorLogin } : {}),
    ...(committer ? { committer } : {}),
    ...(committerLogin ? { committerLogin } : {}),
    ...(optionalString(value.html_url) ? { htmlUrl: value.html_url } : {}),
    message: commit.message,
    parents: Array.isArray(value.parents) ? value.parents.map(parent => (parent as { sha: string }).sha) : [],
    sha: value.sha,
    tree: commit.tree.sha,
  }
}

function parseCommitSummary(value: unknown): string {
  if (!isRecord(value) || !nonEmptyString(value.sha)) malformed("commit list")
  return value.sha
}

function parseBranches(value: unknown): GitHubBranch[] {
  if (!Array.isArray(value)) malformed("branch list")
  return value.map(branch => {
    if (!isRecord(branch) || !nonEmptyString(branch.name) || !isRecord(branch.commit) || !nonEmptyString(branch.commit.sha)) malformed("branch list")
    return { name: branch.name, commit: branch.commit.sha }
  })
}

function isNoHistoryError(error: unknown): boolean {
  const status = githubRequestStatus(error)
  return status === 404 || status === 409
}

function encodeGitHubPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

function nextPage(headers: Headers): number | undefined {
  const link = headers.get("link")
  if (!link) return undefined
  const match = link.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="next"/)
  return match ? Number(match[1]) : undefined
}

function cursorFor(ref: string, page: number): string {
  return `${ref}:${page}`
}

function pageFromCursor(ref: string, cursor: string | undefined): number {
  if (!cursor) return 1
  const separator = cursor.lastIndexOf(":")
  const cursorRef = separator < 0 ? "" : cursor.slice(0, separator)
  const page = separator < 0 ? NaN : Number(cursor.slice(separator + 1))
  if (cursorRef !== ref || !Number.isSafeInteger(page) || page < 1) {
    throw workspaceErrorDiagnostics.WORKSPACE_R0070({ message: `[vitehub] History cursor does not belong to ref "${ref}".` })
  }
  return page
}

function visibleWorkspacePath(path: string): boolean {
  const parts = path.split("/")
  return !parts.some(part => part.toLowerCase() === ".git") && parts[0]?.toLowerCase() !== ".vitehub"
}

function entryMetadata(entry: GitHubHistoryEntry): Record<string, unknown> | undefined {
  return entry.mode === "120000" || entry.mode === "100755" ? { gitMode: entry.mode } : undefined
}

function mediaType(path: string): string {
  return lookup(path) || "application/octet-stream"
}

function publicRevision(commit: GitHubCommit, ref: string, entries: GitHubHistoryEntry[], url?: string, suppliedMetadata?: Record<string, unknown>): WorkspaceRevision {
  const author = commit.author
  const committer = commit.committer
  const authorName = author?.name || committer?.name
  const authorEmail = author?.email || committer?.email
  const authorLogin = commit.authorLogin || commit.committerLogin
  const authorMetadata = authorName || authorEmail || authorLogin
    ? {
        ...(authorName ? { author: authorName } : {}),
        ...(authorEmail ? { authorEmail } : {}),
        ...(authorLogin ? { authorLogin } : {}),
      }
    : {}
  const metadata = Object.keys(authorMetadata).length || commit.htmlUrl || url || suppliedMetadata
    ? {
        ...authorMetadata,
        ...suppliedMetadata,
        ...(commit.htmlUrl || url ? { url: commit.htmlUrl || url } : {}),
      }
    : undefined
  const createdAt = author?.date || committer?.date
  if (!createdAt) malformed("commit")
  return {
    id: commit.sha,
    ref,
    parentId: commit.parents[0] || null,
    createdAt,
    ...(commit.message ? { message: commit.message } : {}),
    ...(metadata ? { metadata } : {}),
    files: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.size, 0),
  }
}

function viewPath(path: string): string {
  return normalizeSafeWorkspacePath(path, { allowEmpty: true }).split("/").filter(Boolean).join("/")
}

function asHistoryEntry(entry: GitHubTreeEntry, root: string): GitHubHistoryEntry | undefined {
  if (entry.type !== "blob") return undefined
  const path = entry.path.startsWith(`${root}/`) ? entry.path.slice(root.length + 1) : root ? undefined : entry.path
  if (path === undefined || !path || !visibleWorkspacePath(path)) return undefined
  return {
    ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    path,
    sha: entry.sha,
    size: entry.size || 0,
  }
}

function isHistoryFileInput(file: WorkspaceFile): file is WorkspaceFile {
  return typeof file.content === "string" || ArrayBuffer.isView(file.content)
}

function isSupportedHistoryRef(name: string): boolean {
  try {
    normalizeHistoryRef(name)
    return true
  }
  catch {
    return false
  }
}

/** A read-through view of GitHub branches and commits using the retained Workspace history contract. */
export function createGitHubWorkspaceHistory(options: GitHubHistoryOptions): WorkspaceStoreHistory {
  const { owner, repo } = splitGitHubRepository(options.repository, "store")
  const commitCache = new Map<string, GitHubCommit>()
  const treeCache = new Map<string, GitHubHistoryEntry[]>()
  const commitRefs = new Map<string, string>()

  const readCommit = async (id: string): Promise<GitHubCommit> => {
    const cached = commitCache.get(id)
    if (cached) return cached
    const { value } = await requestGitHubJsonResponse<unknown>(
      options.repository,
      options.token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(id)}`,
    )
    const commit = parseCommit(value)
    commitCache.set(commit.sha, commit)
    return commit
  }

  const readTree = async (commit: GitHubCommit): Promise<GitHubHistoryEntry[]> => {
    const cached = treeCache.get(commit.sha)
    if (cached) return cached
    const { value } = await requestGitHubJsonResponse<unknown>(
      options.repository,
      options.token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(commit.tree)}?recursive=1`,
    )
    const parsed = parseTree(value)
    const treeEntries = parsed.truncated ? await readTreeWithoutRecursion(commit.tree) : parsed.entries
    const entries = treeEntries.flatMap(entry => {
      const historyEntry = asHistoryEntry(entry, options.root)
      return historyEntry ? [historyEntry] : []
    }).sort((left, right) => left.path.localeCompare(right.path))
    treeCache.set(commit.sha, entries)
    return entries
  }

  const readTreeWithoutRecursion = async (treeSha: string): Promise<GitHubTreeEntry[]> => {
    const root = options.root.replace(/^\/+|\/+$/g, "")
    const entries: GitHubTreeEntry[] = []
    const walk = async (sha: string, prefix: string): Promise<void> => {
      const { value } = await requestGitHubJsonResponse<unknown>(
        options.repository,
        options.token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(sha)}`,
      )
      const parsed = parseTree(value)
      if (parsed.truncated) {
        throw workspaceError("[vitehub] GitHub workspace tree was truncated while traversing a directory.")
      }
      for (const entry of parsed.entries) {
        const path = prefix ? `${prefix}/${entry.path}` : entry.path
        const relevant = !root || path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`)
        if (!relevant) continue
        if (entry.type === "tree") await walk(entry.sha, path)
        else entries.push({ ...entry, path })
      }
    }
    await walk(treeSha, "")
    return entries
  }

  const revision = async (ref: string, id: string, suppliedMetadata?: Record<string, unknown>): Promise<WorkspaceRevision> => {
    const commit = await readCommit(id)
    const entries = await readTree(commit)
    commitRefs.set(commit.sha, ref)
    return publicRevision(commit, ref, entries, `https://github.com/${options.repository}/commit/${commit.sha}`, suppliedMetadata)
  }

  const readBranches = async (): Promise<{ branches: GitHubBranch[], headers: Headers }> => {
    const branches: GitHubBranch[] = []
    let page = 1
    let headers = new Headers()
    while (true) {
      let response: { value: unknown, headers: Headers }
      try {
        response = await requestGitHubJsonResponse<unknown>(
          options.repository,
          options.token,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100&page=${page}`,
        )
      }
      catch (error) {
        if (isNoHistoryError(error)) return { branches: [], headers }
        throw error
      }
      headers = response.headers
      const pageBranches = parseBranches(response.value)
      branches.push(...pageBranches.filter(branch => isSupportedHistoryRef(branch.name)))
      const next = nextPage(headers)
      if (!next || !pageBranches.length) return { branches, headers }
      page = next
    }
  }

  const readBranchHead = async (ref: string): Promise<string | null> => {
    try {
      const { value } = await requestGitHubJsonResponse<unknown>(
        options.repository,
        options.token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeGitHubPath(ref)}`,
      )
      if (!isRecord(value) || !isRecord(value.object) || !nonEmptyString(value.object.sha)) malformed("branch reference")
      return value.object.sha
    }
    catch (error) {
      if (isNoHistoryError(error)) return null
      throw error
    }
  }

  const list = async (listOptions: WorkspaceHistoryListOptions = {}): Promise<WorkspaceHistoryListResult> => {
    const ref = normalizeHistoryRef(listOptions.ref)
    const limit = listOptions.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw workspaceErrorDiagnostics.WORKSPACE_R0070({ message: "[vitehub] History list limit must be an integer from 1 to 100." })
    }
    const page = pageFromCursor(ref, listOptions.cursor)
    let response: { value: unknown, headers: Headers }
    try {
      response = await requestGitHubJsonResponse<unknown>(
        options.repository,
        options.token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(ref)}&per_page=${limit}&page=${page}`,
      )
    }
    catch (error) {
      if (isNoHistoryError(error)) return { revisions: [] }
      throw error
    }
    if (!Array.isArray(response.value)) malformed("commit list")
    const ids = response.value.map(parseCommitSummary)
    const revisions = await Promise.all(ids.slice(0, limit).map(id => revision(ref, id)))
    const linkedNext = nextPage(response.headers)
    // GitHub normally supplies Link. Keep a length-based fallback for compatible
    // GitHub proxies that omit it, even though that can expose one empty page at
    // the end of a full page.
    const followingPage = linkedNext ?? (ids.length === limit ? page + 1 : undefined)
    return {
      revisions,
      ...(followingPage === undefined ? {} : { cursor: cursorFor(ref, followingPage) }),
    }
  }

  const refs = async (): Promise<WorkspaceHistoryRef[]> => {
    const { branches } = await readBranches()
    const result = await Promise.all(branches.map(async branch => ({ name: branch.name, head: await revision(branch.name, branch.commit) })))
    return result.sort((left, right) => left.name.localeCompare(right.name))
  }

  const refForCommit = async (id: string): Promise<string> => {
    const cached = commitRefs.get(id)
    if (cached) return cached
    try {
      const { value } = await requestGitHubJsonResponse<unknown>(
        options.repository,
        options.token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(id)}/branches-where-head?per_page=100`,
      )
      const branches = parseBranches(value)
      const supportedBranches = branches.filter(branch => isSupportedHistoryRef(branch.name))
      const ref = supportedBranches.find(branch => branch.name === options.branch)?.name || supportedBranches[0]?.name || options.branch
      commitRefs.set(id, ref)
      return ref
    }
    catch (error) {
      if (isNoHistoryError(error)) return options.branch
      throw error
    }
  }

  const open = async (id: string): Promise<WorkspaceRevisionView> => {
    if (!nonEmptyString(id)) throw workspaceError("[vitehub] Workspace revision id must be a non-empty string.")
    let commit: GitHubCommit
    try {
      commit = await readCommit(id)
    }
    catch (error) {
      if (githubRequestStatus(error) === 404) throw workspaceError(`[vitehub] Workspace revision does not exist: ${id}.`)
      throw error
    }
    const ref = await refForCommit(commit.sha)
    const entries = await readTree(commit)
    const byPath = new Map(entries.map(entry => [entry.path, entry]))
    const directories = new Map<string, WorkspaceEntry>()
    directories.set("", { path: "", type: "directory" })
    for (const entry of entries) {
      const parts = entry.path.split("/")
      for (let index = 1; index < parts.length; index++) {
        const path = parts.slice(0, index).join("/")
        directories.set(path, { path, type: "directory" })
      }
    }
    const revisionValue = publicRevision(commit, ref, entries, `https://github.com/${options.repository}/commit/${commit.sha}`)
    const view = Object.freeze({
      revision: revisionValue,
      list: async (path = "", listOptions?: ListOptions): Promise<WorkspaceEntry[]> => {
        const prefix = viewPath(path)
        return [...directories.values(), ...entries.map(entry => ({
          path: entry.path,
          type: "file" as const,
          size: entry.size,
          mediaType: mediaType(entry.path),
          ...(entryMetadata(entry) ? { metadata: entryMetadata(entry) } : {}),
        }))]
          .filter(entry => entry.path && entry.path !== prefix
            && (!prefix || entry.path.startsWith(`${prefix}/`))
            && !isExcludedWorkspacePath(entry.path, listOptions?.exclude)
            && (listOptions?.recursive || !entry.path.slice(prefix ? prefix.length + 1 : 0).includes("/")))
          .sort((left, right) => left.path.localeCompare(right.path))
      },
      stat: async (path: string) => {
        const normalized = viewPath(path)
        const directory = directories.get(normalized)
        if (directory) return { ...directory }
        const entry = byPath.get(normalized)
        if (!entry) throw workspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
        return {
          path: normalized,
          type: "file" as const,
          revision: commit.sha,
          size: entry.size,
          mediaType: mediaType(normalized),
          ...(entryMetadata(entry) ? { metadata: entryMetadata(entry) } : {}),
        }
      },
      readFile: async <TOptions extends ReadFileOptions | undefined = undefined>(path: string, readOptions?: TOptions) => {
        const normalized = normalizeHistoryPath(path)
        const entry = byPath.get(normalized)
        if (!entry) throw workspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
        const bytes = await readGitHubRawFile({
          path: joinGitPath(options.root, normalized),
          ref: commit.sha,
          repository: options.repository,
          token: options.token,
        })
        return decodeFile(bytes, readOptions)
      },
    })
    return view
  }

  const usage = async (): Promise<{ bytes: number, objects: number }> => {
    const branchResult = await readBranches()
    const seen = new Set<string>()
    let bytes = 0
    for (const branch of branchResult.branches) {
      let cursor: string | undefined
      do {
        const page = await list({ ref: branch.name, cursor, limit: 100 })
        for (const revisionValue of page.revisions) {
          const entries = await readTree(await readCommit(revisionValue.id))
          for (const entry of entries) {
            if (seen.has(entry.sha)) continue
            seen.add(entry.sha)
            bytes += entry.size
          }
        }
        cursor = page.cursor
      } while (cursor)
    }
    return { bytes, objects: seen.size }
  }

  const commit = async (commitOptions: WorkspaceStoreHistoryCommitOptions): Promise<WorkspaceRevision> => {
    const ref = normalizeHistoryRef(commitOptions.ref)
    if (commitOptions.ifHead !== null && !nonEmptyString(commitOptions.ifHead)) throw workspaceError("[vitehub] History commit requires ifHead to be a revision id or null.")
    const state = await readGitHubBranchState({ branch: ref, kind: "store", repository: options.repository, root: options.root, token: options.token })
    const actual = state.branchExists ? state.refSha : null
    if (actual !== commitOptions.ifHead) throw historyConflict(ref, commitOptions.ifHead, actual)
    const updates: Array<{ bytes: Uint8Array, fullPath: string, gitSha: string, mode?: string }> = []
    const deletes: string[] = []
    const desired = new Map<string, WorkspaceFile>()
    if (commitOptions.files !== undefined) {
      for (const [path, file] of Object.entries(commitOptions.files)) desired.set(normalizeHistoryPath(path), file)
      for (const [path] of state.files) if (visibleWorkspacePath(path) && !desired.has(path)) deletes.push(joinGitPath(options.root, path))
    }
    else {
      for (const [path, file] of Object.entries(commitOptions.changes?.put || {})) desired.set(normalizeHistoryPath(path), file)
      for (const path of commitOptions.changes?.delete || []) {
        const normalized = normalizeHistoryPath(path)
        if (!state.files.has(normalized)) throw workspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
        deletes.push(joinGitPath(options.root, normalized))
      }
    }
    for (const [path, file] of desired) {
      if (!isHistoryFileInput(file)) throw workspaceError(`[vitehub] Invalid history file content: ${path}.`)
      const bytes = new Uint8Array(contentToBytes(file.content))
      const current = state.files.get(path)
      const mode = file.metadata?.gitMode === "120000" || file.metadata?.gitMode === "100755"
        ? file.metadata.gitMode
        : current?.mode
      const gitSha = await gitBlobSha(bytes)
      if (current?.sha === gitSha && (current.mode || "100644") === (mode || "100644")) continue
      updates.push({ bytes, fullPath: joinGitPath(options.root, path), gitSha, ...(mode ? { mode } : {}) })
    }
    const result = await commitGitHubChanges({
      baseTreeSha: state.treeSha,
      branch: ref,
      branchExists: state.branchExists,
      deletePaths: deletes,
      files: updates,
      message: commitOptions.message || "Update Workspace",
      parentSha: state.refSha,
      repository: options.repository,
      token: options.token,
    })
    return await revision(ref, result.commitSha, commitOptions.metadata)
  }

  return {
    head: async (headOptions) => {
      const ref = normalizeHistoryRef(headOptions?.ref)
      const id = await readBranchHead(ref)
      return id ? await revision(ref, id) : null
    },
    list,
    refs,
    open,
    usage,
    commit,
  }
}
