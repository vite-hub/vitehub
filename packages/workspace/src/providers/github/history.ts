import type { Commit, Page, TreeEntry } from "@vite-hub/forge"
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
  readCurrentHead,
  readGitHubBranchState,
  readGitHubFile,
  type GitFileMode,
  type GitHubFileUpdate,
  type GitHubRepository,
} from "./shared.ts"

import type {
  GitHubWorkspaceRefs,
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
  /** Branch names for the history refs `published` and `draft`. */
  refs?: GitHubWorkspaceRefs
  repository: string
  root: string
}

/**
 * How long `head()` keeps the head that it read for a branch, in milliseconds. A commit through this history replaces
 * the head at once. A commit by another writer shows after this time at most.
 */
export const githubHeadCacheMs = 5_000

const metadataTrailer = "Vitehub-Metadata: "
const metadataTrailerPattern = /\n*^Vitehub-Metadata: (.*)$/m

type GitHubCommit = Commit
type GitHubTreeItem = TreeEntry

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

/** The message of a commit without its metadata trailer, and the metadata that the trailer holds. */
function readCommitMessage(message: string | undefined): { message?: string, metadata?: Record<string, unknown> } {
  if (!message) return {}
  const match = metadataTrailerPattern.exec(message)
  if (!match) return { message }
  let metadata: Record<string, unknown> | undefined
  try {
    const value: unknown = JSON.parse(match[1]!)
    if (value !== null && typeof value === "object" && !Array.isArray(value)) metadata = Object.fromEntries(Object.entries(value))
  }
  catch {
    // A trailer that is not JSON stays in the message, as written by another tool.
    return { message }
  }
  if (!metadata) return { message }
  const text = message.slice(0, match.index).trimEnd()
  return { ...(text ? { message: text } : {}), metadata }
}

function messageWithMetadata(message: string, metadata: Record<string, unknown> | undefined): string {
  if (!metadata || !Object.keys(metadata).length) return message
  return `${message}\n\n${metadataTrailer}${JSON.stringify(metadata)}`
}

function publicRevision(commit: GitHubCommit, ref: string, entries: GitHubHistoryEntry[], url?: string, suppliedMetadata?: Record<string, unknown>): WorkspaceRevision {
  const stored = readCommitMessage(commit.message)
  suppliedMetadata ??= stored.metadata
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
    ...(stored.message ? { message: stored.message } : {}),
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
export function createGitHubWorkspaceHistory(input: GitHubHistoryOptions | (() => GitHubHistoryOptions)): WorkspaceStoreHistory {
  // The options resolve on first use, so a Store without a repository or token fails at its first request and not when it is created.
  let resolved: GitHubHistoryOptions | undefined
  const settings = (): GitHubHistoryOptions => resolved ??= typeof input === "function" ? input() : input
  const options = {
    get branch() { return settings().branch },
    get refs() { return settings().refs },
    get repository() { return settings().repository },
    get root() { return settings().root },
  }
  const client: GitHubRepository = {
    get name() { return settings().client.name },
    provider: async () => await settings().client.provider(),
    ref: provider => settings().client.ref(provider),
  }
  // The history ref `published` or `draft` is a branch with another name when `refs` says so.
  const toBranch = (ref: string): string => {
    const refs = options.refs
    return (ref === "published" ? refs?.published : ref === "draft" ? refs?.draft : undefined) ?? ref
  }
  const fromBranch = (branch: string): string => {
    const refs = options.refs
    if (refs?.published === branch) return "published"
    if (refs?.draft === branch) return "draft"
    return branch
  }
  // A branch that is named like an aliased ref would show as the same ref twice.
  const hiddenBranch = (branch: string): boolean => (branch === "published" && Boolean(options.refs?.published) && options.refs?.published !== branch)
    || (branch === "draft" && Boolean(options.refs?.draft) && options.refs?.draft !== branch)
  const heads = new Map<string, { expires: number, head: Promise<string | null> }>()
  const commitCache = new Map<string, GitHubCommit>()
  const treeCache = new Map<string, GitHubHistoryEntry[]>()
  const commitRefs = new Map<string, string>()

  const readCommit = async (id: string): Promise<GitHubCommit> => {
    const cached = commitCache.get(id)
    if (cached) return cached
    const commit = await githubRequest(client, async (provider, repo) => await provider.commits.get({ forge: provider.forge, instance: provider.instance, repo, sha: encodeURIComponent(id) }), "commit")
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
          if (isSupportedHistoryRef(branch.name) && !hiddenBranch(branch.name)) branches.push({ commit: branch.sha, name: branch.name })
        }
        return branches
      }, "branch list")
    }
    catch (error) {
      if (isNoHistoryError(error)) return []
      throw error
    }
  }

  const readBranchHead = async (branch: string): Promise<string | null> => {
    const cached = heads.get(branch)
    if (cached && cached.expires > Date.now()) return await cached.head
    const head = (async () => {
      try {
        return await githubRequest(client, async (provider, repo) => await provider.contents.resolveRef(repo, `heads/${branch}`), "commit")
      }
      catch (error) {
        if (isNoHistoryError(error) || githubRequestStatus(error) === 422) return null
        throw error
      }
    })()
    heads.set(branch, { expires: Date.now() + githubHeadCacheMs, head })
    // A failed read is not kept.
    head.catch(() => {
      if (heads.get(branch)?.head === head) heads.delete(branch)
    })
    return await head
  }

  const list = async (listOptions: WorkspaceHistoryListOptions = {}): Promise<WorkspaceHistoryListResult> => {
    const ref = normalizeHistoryRef(listOptions.ref)
    const branch = toBranch(ref)
    const limit = listOptions.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw workspaceErrorDiagnostics.WORKSPACE_R0070({ message: "[vitehub] History list limit must be an integer from 1 to 100." })
    }
    // A revision id as the cursor lists the revisions after that one, as the Blob + Database Store does.
    const afterId = listOptions.cursor && /^[0-9a-f]{40}$/i.test(listOptions.cursor) ? listOptions.cursor : undefined
    const page = afterId ? 1 : pageFromCursor(ref, listOptions.cursor)
    // Only the commits that changed this file or folder.
    const gitPath = !listOptions.path ? "" : joinGitPath(options.root, normalizeHistoryPath(listOptions.path))
    let result: Page<Commit>
    try {
      result = await githubRequest(client, async (provider, repo) => {
        // A history cursor names a page number. Build the GitHub page URL that the Forge cursor needs for it.
        const cursor = page === 1
          ? undefined
          : { nextUrl: `${provider.baseUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}&page=${page}${gitPath ? `&path=${encodeURIComponent(gitPath)}` : ""}` }
        return await provider.commits.list(repo, { cursor, perPage: afterId ? Math.min(limit + 1, 100) : limit, ref: afterId ?? branch, ...(gitPath ? { path: gitPath } : {}) }).page()
      }, "commit list")
    }
    catch (error) {
      if (isNoHistoryError(error)) return { revisions: [] }
      throw error
    }
    // The listing starts at the cursor's revision, which the caller already has.
    const items = afterId && result.items[0]?.sha === afterId ? result.items.slice(1) : result.items
    const shown = items.slice(0, limit)
    const revisions = await Promise.all(shown.map(commit => {
      if (!nonEmptyString(commit.sha)) malformed("commit list")
      return revision(ref, commit.sha)
    }))
    const followingPage = nextPage(result.cursor?.nextUrl)
    if (afterId) {
      const last = shown.at(-1)?.sha
      return { revisions, ...(last && (items.length > limit || followingPage !== undefined) ? { cursor: last } : {}) }
    }
    return {
      revisions,
      ...(followingPage === undefined ? {} : { cursor: cursorFor(ref, followingPage) }),
    }
  }

  const refs = async (): Promise<WorkspaceHistoryRef[]> => {
    const branches = await readBranches()
    const result = await Promise.all(branches.map(async branch => ({ name: fromBranch(branch.name), head: await revision(fromBranch(branch.name), branch.commit) })))
    return result.sort((left, right) => left.name.localeCompare(right.name))
  }

  const refForCommit = async (id: string): Promise<string> => {
    const cached = commitRefs.get(id)
    if (cached) return cached
    const branches = (await readBranches()).filter(branch => branch.commit === id)
    const ref = fromBranch(branches.find(branch => branch.name === options.branch)?.name || branches[0]?.name || options.branch)
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
          digest: entry.sha,
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
          digest: entry.sha,
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
        const page = await list({ ref: fromBranch(branch.name), cursor, limit: 100 })
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
    const branch = toBranch(ref)
    if (commitOptions.ifHead !== null && !nonEmptyString(commitOptions.ifHead)) throw workspaceError("[vitehub] History commit requires ifHead to be a revision id or null.")
    // A branch that does not exist yet starts from the published branch when `refs` names one, else from the default branch.
    const publishedBranch = options.refs?.published
    const state = await readGitHubBranchState({ branch, fork: publishedBranch && publishedBranch !== branch ? publishedBranch : undefined, repository: client, root: options.root })
    const actual = state.branchExists ? state.refSha : null
    // A conflict means the cached head was stale, so the next read asks GitHub.
    if (actual !== commitOptions.ifHead) {
      heads.delete(branch)
      throw historyConflict(ref, commitOptions.ifHead, actual)
    }
    // GitHub stores refs as independent branches, so the cross-ref expectation
    // cannot be included in the ref update itself. Recheck every expected ref
    // immediately before constructing the commit rather than silently ignoring
    // the assertion (which would allow pinned publishes to use stale drafts).
    for (const [expectedRef, expectedHead] of Object.entries(commitOptions.ifHeads ?? {})) {
      const name = normalizeHistoryRef(expectedRef)
      const currentHead = await readCurrentHead(client, toBranch(name))
      if (currentHead !== expectedHead) {
        heads.delete(toBranch(name))
        throw historyConflict(name, expectedHead, currentHead)
      }
    }
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
    if (!updates.length && !deletes.length) {
      // `commitFiles()` cannot make an empty commit. A commit without changes keeps the current head.
      if (state.branchExists) return await revision(ref, state.refSha, commitOptions.metadata)
      throw workspaceError(`[vitehub] GitHub history commit cannot create ref "${ref}" without a file change.`)
    }
    const commitSha = await commitGitHubChanges({
      branch,
      branchExists: state.branchExists,
      deletePaths: deletes,
      files: updates,
      message: messageWithMetadata(commitOptions.message || "Update Workspace", commitOptions.metadata),
      parentSha: state.refSha,
      remoteModes: new Map([...state.files.values()].map(entry => [entry.path, entry.mode])),
      repository: client,
    })
    heads.set(branch, { expires: Date.now() + githubHeadCacheMs, head: Promise.resolve(commitSha) })
    return await revision(ref, commitSha, commitOptions.metadata)
  }

  return {
    head: async (headOptions) => {
      const ref = normalizeHistoryRef(headOptions?.ref)
      const id = await readBranchHead(toBranch(ref))
      return id ? await revision(ref, id) : null
    },
    digest: gitBlobSha,
    forksFrom: async ref => options.refs?.published && ref !== "published" ? "published" : undefined,
    list,
    refs,
    open,
    usage,
    commit,
  }
}
