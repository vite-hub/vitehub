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
  gitFileMode,
  githubRequest,
  githubRequestStatus,
  joinGitPath,
  readGitHubBranchState,
  readGitHubFile,
  type GitFileMode,
  type GitHubFileUpdate,
  type GitHubProvider,
  type GitHubRepository,
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

interface GitHubHistoryOptions {
  branch: string
  client: GitHubRepository
  repository: string
  root: string
}

type GitHubCommit = Awaited<ReturnType<GitHubProvider["contents"]["commit"]>>
type GitHubTreeItem = Awaited<ReturnType<GitHubProvider["contents"]["treePage"]>>["items"][number]

interface GitHubHistoryEntry {
  mode: GitFileMode
  path: string
  sha: string
  size: number
}

interface GitHubBranch {
  commit: string
  name: string
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function malformed(description: string): never {
  throw workspaceError(`[vitehub] GitHub workspace returned a malformed ${description} response.`)
}

function isNoHistoryError(error: unknown): boolean {
  const status = githubRequestStatus(error)
  return status === 404 || status === 409
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

/** The page number of the next GitHub page, from the Forge cursor. */
function nextPage(nextUrl: string | undefined): number | undefined {
  if (!nextUrl) return undefined
  const page = Number(new URL(nextUrl).searchParams.get("page"))
  return Number.isSafeInteger(page) && page > 1 ? page : undefined
}

function visibleWorkspacePath(path: string): boolean {
  const parts = path.split("/")
  return !parts.some(part => part.toLowerCase() === ".git") && parts[0]?.toLowerCase() !== ".vitehub"
}

function entryMetadata(entry: GitHubHistoryEntry): Record<string, unknown> | undefined {
  return entry.mode === "100644" ? undefined : { gitMode: entry.mode }
}

function mediaType(path: string): string {
  return lookup(path) || "application/octet-stream"
}

function publicRevision(commit: GitHubCommit, ref: string, entries: GitHubHistoryEntry[], url?: string, suppliedMetadata?: Record<string, unknown>): WorkspaceRevision {
  const author = commit.author
  const committer = commit.committer
  const authorName = author?.name || committer?.name
  const authorEmail = author?.email || committer?.email
  const authorLogin = author?.actor?.login || committer?.actor?.login
  const authorMetadata = authorName || authorEmail || authorLogin
    ? {
        ...(authorName ? { author: authorName } : {}),
        ...(authorEmail ? { authorEmail } : {}),
        ...(authorLogin ? { authorLogin } : {}),
      }
    : {}
  const metadata = Object.keys(authorMetadata).length || commit.url || url || suppliedMetadata
    ? {
        ...authorMetadata,
        ...suppliedMetadata,
        ...(commit.url || url ? { url: commit.url || url } : {}),
      }
    : undefined
  const createdAt = author?.date || committer?.date
  if (!createdAt || Number.isNaN(createdAt.getTime())) malformed("commit")
  return {
    id: commit.sha,
    ref,
    parentId: commit.parents[0] || null,
    createdAt: createdAt.toISOString(),
    ...(commit.message ? { message: commit.message } : {}),
    ...(metadata ? { metadata } : {}),
    files: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.size, 0),
  }
}

function viewPath(path: string): string {
  return normalizeSafeWorkspacePath(path, { allowEmpty: true }).split("/").filter(Boolean).join("/")
}

function asHistoryEntry(entry: GitHubTreeItem, root: string): GitHubHistoryEntry | undefined {
  if (entry.type !== "file" && entry.type !== "symlink") return undefined
  if (!entry.sha) malformed("tree")
  const path = entry.path.startsWith(`${root}/`) ? entry.path.slice(root.length + 1) : root ? undefined : entry.path
  if (path === undefined || !path || !visibleWorkspacePath(path)) return undefined
  return {
    mode: gitFileMode(entry.mode),
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
  const client = options.client
  const commitCache = new Map<string, GitHubCommit>()
  const treeCache = new Map<string, GitHubHistoryEntry[]>()
  const commitRefs = new Map<string, string>()

  const readCommit = async (id: string): Promise<GitHubCommit> => {
    const cached = commitCache.get(id)
    if (cached) return cached
    const commit = await githubRequest(client, async (provider, repo) => await provider.contents.commit(repo, encodeURIComponent(id)), "commit")
    if (!nonEmptyString(commit.sha)) malformed("commit")
    commitCache.set(commit.sha, commit)
    return commit
  }

  const readTreeItems = async (ref: string, recursive: boolean) => await githubRequest(client, async (provider, repo) => {
    const tree = provider.contents.tree(repo, { recursive, ref })
    const items: GitHubTreeItem[] = []
    for await (const item of tree) items.push(item)
    return { items, truncated: tree.warnings.some(warning => warning.code === "tree_truncated") }
  }, "tree")

  const readTree = async (commit: GitHubCommit): Promise<GitHubHistoryEntry[]> => {
    const cached = treeCache.get(commit.sha)
    if (cached) return cached
    const tree = await readTreeItems(commit.sha, true)
    const treeEntries = tree.truncated ? await readTreeWithoutRecursion(commit.sha) : tree.items
    const entries = treeEntries.flatMap(entry => {
      const historyEntry = asHistoryEntry(entry, options.root)
      return historyEntry ? [historyEntry] : []
    }).sort((left, right) => left.path.localeCompare(right.path))
    treeCache.set(commit.sha, entries)
    return entries
  }

  const readTreeWithoutRecursion = async (ref: string): Promise<GitHubTreeItem[]> => {
    const root = options.root.replace(/^\/+|\/+$/g, "")
    const entries: GitHubTreeItem[] = []
    const walk = async (sha: string, prefix: string): Promise<void> => {
      const tree = await readTreeItems(sha, false)
      if (tree.truncated) {
        throw workspaceError("[vitehub] GitHub workspace tree was truncated while traversing a directory.")
      }
      for (const entry of tree.items) {
        const path = prefix ? `${prefix}/${entry.path}` : entry.path
        const relevant = !root || path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`)
        if (!relevant) continue
        if (entry.type === "directory") {
          if (!entry.sha) malformed("tree")
          await walk(entry.sha, path)
        }
        else entries.push({ ...entry, path })
      }
    }
    await walk(ref, "")
    return entries
  }

  const revision = async (ref: string, id: string, suppliedMetadata?: Record<string, unknown>): Promise<WorkspaceRevision> => {
    const commit = await readCommit(id)
    const entries = await readTree(commit)
    commitRefs.set(commit.sha, ref)
    return publicRevision(commit, ref, entries, `https://github.com/${options.repository}/commit/${commit.sha}`, suppliedMetadata)
  }

  const readBranches = async (): Promise<GitHubBranch[]> => {
    try {
      return await githubRequest(client, async (provider, repo) => {
        const branches: GitHubBranch[] = []
        for await (const branch of provider.contents.branches(repo, { perPage: 100 })) {
          if (!nonEmptyString(branch.name) || !nonEmptyString(branch.sha)) malformed("branch list")
          if (isSupportedHistoryRef(branch.name)) branches.push({ commit: branch.sha, name: branch.name })
        }
        return branches
      }, "branch list")
    }
    catch (error) {
      if (isNoHistoryError(error)) return []
      throw error
    }
  }

  const readBranchHead = async (ref: string): Promise<string | null> => {
    try {
      return await githubRequest(client, async (provider, repo) => await provider.contents.resolveRef(repo, ref), "commit")
    }
    catch (error) {
      if (isNoHistoryError(error) || githubRequestStatus(error) === 422) return null
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
    let result: Awaited<ReturnType<GitHubProvider["contents"]["commitsPage"]>>
    try {
      result = await githubRequest(client, async (provider, repo) => {
        // A history cursor names a page number. Build the GitHub page URL that the Forge cursor needs for it.
        const cursor = page === 1
          ? undefined
          : { nextUrl: `${provider.baseUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits?sha=${encodeURIComponent(ref)}&per_page=${limit}&page=${page}` }
        return await provider.contents.commitsPage(repo, { cursor, perPage: limit, ref })
      }, "commit list")
    }
    catch (error) {
      if (isNoHistoryError(error)) return { revisions: [] }
      throw error
    }
    const revisions = await Promise.all(result.items.slice(0, limit).map(commit => {
      if (!nonEmptyString(commit.sha)) malformed("commit list")
      return revision(ref, commit.sha)
    }))
    const followingPage = nextPage(result.cursor?.nextUrl)
    return {
      revisions,
      ...(followingPage === undefined ? {} : { cursor: cursorFor(ref, followingPage) }),
    }
  }

  const refs = async (): Promise<WorkspaceHistoryRef[]> => {
    const branches = await readBranches()
    const result = await Promise.all(branches.map(async branch => ({ name: branch.name, head: await revision(branch.name, branch.commit) })))
    return result.sort((left, right) => left.name.localeCompare(right.name))
  }

  const refForCommit = async (id: string): Promise<string> => {
    const cached = commitRefs.get(id)
    if (cached) return cached
    const branches = (await readBranches()).filter(branch => branch.commit === id)
    const ref = branches.find(branch => branch.name === options.branch)?.name || branches[0]?.name || options.branch
    commitRefs.set(id, ref)
    return ref
  }

  const open = async (id: string): Promise<WorkspaceRevisionView> => {
    if (!nonEmptyString(id)) throw workspaceError("[vitehub] Workspace revision id must be a non-empty string.")
    let commit: GitHubCommit
    try {
      commit = await readCommit(id)
    }
    catch (error) {
      const status = githubRequestStatus(error)
      if (status === 404 || status === 422) throw workspaceError(`[vitehub] Workspace revision does not exist: ${id}.`)
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
        const bytes = await readGitHubFile(client, { ...entry, path: joinGitPath(options.root, normalized) }, commit.sha)
        return decodeFile(bytes, readOptions)
      },
    })
    return view
  }

  const usage = async (): Promise<{ bytes: number, objects: number }> => {
    const branches = await readBranches()
    const seen = new Set<string>()
    let bytes = 0
    for (const branch of branches) {
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
    const state = await readGitHubBranchState({ branch: ref, repository: client, root: options.root })
    const actual = state.branchExists ? state.refSha : null
    if (actual !== commitOptions.ifHead) throw historyConflict(ref, commitOptions.ifHead, actual)
    const updates: GitHubFileUpdate[] = []
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
        : current?.mode ?? "100644"
      if (current?.sha === await gitBlobSha(bytes) && current.mode === mode) continue
      updates.push({ bytes, fullPath: joinGitPath(options.root, path), mode })
    }
    // Keep empty commits: they are real history revisions and may be used as the next `ifHead`.
    const commitSha = await commitGitHubChanges({
      branch: ref,
      branchExists: state.branchExists,
      deletePaths: deletes,
      files: updates,
      message: commitOptions.message || "Update Workspace",
      parentSha: state.refSha,
      remoteModes: new Map([...state.files.values()].map(entry => [entry.path, entry.mode])),
      repository: client,
    })
    return await revision(ref, commitSha, commitOptions.metadata)
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
