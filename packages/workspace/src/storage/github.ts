import { WorkspaceError } from "../core/errors.ts"
import { contentToBytes, matchesAny, normalizeWorkspacePath, sha256 } from "../core/path.ts"

import type {
  DiffOptions,
  GitHubWorkspaceStoreOption,
  GitHubWorkspaceStoreOptions,
  GlobOptions,
  ListOptions,
  MkdirOptions,
  RmOptions,
  SnapshotOptions,
  WorkspaceDiff,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceSnapshot,
  WorkspaceStat,
  WorkspaceStore,
} from "../core/types.ts"

interface GitHubWorkspaceFile extends WorkspaceFile {
  mtime: number
}

export interface GitHubWorkspaceCommitSnapshot extends WorkspaceSnapshot {
  files: string[]
  sha: string
  url: string
}

type GitHubWorkspaceStoreResolvedOptions = {
  branch: GitHubWorkspaceStoreOption
  repo: GitHubWorkspaceStoreOption
  root: GitHubWorkspaceStoreOption
  token: GitHubWorkspaceStoreOption
}

function splitRepository(repository: string) {
  const [owner, repo] = repository.split("/")
  if (!owner || !repo) {
    throw new WorkspaceError("[vitehub] GitHub workspace store requires a repository in owner/repo format.")
  }
  return { owner, repo }
}

function resolveOption(value: GitHubWorkspaceStoreOption): string | undefined {
  return typeof value === "function" ? value() : value
}

function requireOption(label: string, value: GitHubWorkspaceStoreOption): string {
  const resolved = resolveOption(value)
  if (!resolved) throw new WorkspaceError(`[vitehub] GitHub workspace store requires ${label}.`)
  return resolved
}

function joinGitPath(...parts: string[]) {
  return parts.join("/").replaceAll("\\", "/").split("/").filter(Boolean).join("/")
}

function fileSize(file: WorkspaceFile) {
  return contentToBytes(file.content).byteLength
}

class GitHubWorkspaceStore implements WorkspaceStore {
  #baseline: WorkspaceSnapshot | undefined
  #files = new Map<string, GitHubWorkspaceFile>()
  #meta = new Map<string, unknown>()

  constructor(private options: GitHubWorkspaceStoreResolvedOptions) {}

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    return this.#files.get(normalizeWorkspacePath(path))
  }

  async writeFile(path: string, file: WorkspaceFile): Promise<void> {
    const normalized = normalizeWorkspacePath(path)
    this.#files.set(normalized, {
      ...file,
      path: normalized,
      mtime: Date.now(),
    })
  }

  async list(prefix = "", options: ListOptions = {}): Promise<WorkspaceEntry[]> {
    const normalizedPrefix = normalizeWorkspacePath(prefix)
    const entries = new Map<string, WorkspaceEntry>()
    for (const file of this.#files.values()) {
      if (normalizedPrefix && file.path !== normalizedPrefix && !file.path.startsWith(`${normalizedPrefix}/`)) continue
      const relative = normalizedPrefix ? file.path.slice(normalizedPrefix.length).replace(/^\//, "") : file.path
      if (!options.recursive && relative.includes("/")) {
        const directory = joinGitPath(normalizedPrefix, relative.split("/")[0]!)
        entries.set(directory, { path: directory, type: "directory" })
        continue
      }
      entries.set(file.path, await this.#entry(file))
    }
    return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path))
  }

  async glob(pattern: string | string[], options: GlobOptions = {}): Promise<WorkspaceEntry[]> {
    const patterns = Array.isArray(pattern) ? pattern : [pattern]
    const normalizedPatterns = patterns.map(item => joinGitPath(options.cwd || "", item))
    return (await this.list("", { recursive: true }))
      .filter(entry => entry.type === "file" && normalizedPatterns.some(item => matchesAny(entry.path, item)))
  }

  async stat(path: string): Promise<WorkspaceStat | undefined> {
    const file = this.#files.get(normalizeWorkspacePath(path))
    return file ? await this.#entry(file) : undefined
  }

  async mkdir(_path: string, _options: MkdirOptions = {}): Promise<void> {}

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    const normalized = normalizeWorkspacePath(path)
    const matched = [...this.#files.keys()].filter(key => key === normalized || key.startsWith(`${normalized}/`))
    if (!matched.length && !options.force) {
      throw new WorkspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
    }
    if (matched.length > 1 && !options.recursive) {
      throw new WorkspaceError(`[vitehub] Workspace directory is not empty: ${path}.`)
    }
    for (const key of matched) this.#files.delete(key)
  }

  async snapshot(options: SnapshotOptions = {}): Promise<GitHubWorkspaceCommitSnapshot> {
    const files = [...this.#files.values()]
    if (!files.length) {
      throw new WorkspaceError("[vitehub] GitHub workspace store cannot publish an empty snapshot.")
    }

    const { owner, repo } = splitRepository(requireOption("a repository", this.options.repo))
    const branch = requireOption("a branch", this.options.branch)
    const root = resolveOption(this.options.root) || ""
    const refPath = `/repos/${owner}/${repo}/git/ref/heads/${branch}`
    const refsPath = `/repos/${owner}/${repo}/git/refs/heads/${branch}`
    const ref = await this.#github<{ object: { sha: string } }>(refPath)
    const current = await this.#github<{ tree: { sha: string } }>(`/repos/${owner}/${repo}/git/commits/${ref.object.sha}`)
    const blobs = await Promise.all(files.map(file => this.#github<{ sha: string }>(`/repos/${owner}/${repo}/git/blobs`, {
      body: JSON.stringify({ content: Buffer.from(contentToBytes(file.content)).toString("base64"), encoding: "base64" }),
      method: "POST",
    })))
    const nextPaths = new Set(files.map(file => file.path))
    const deletedEntries = Object.keys(this.#baseline?.entries || {})
      .filter(path => !nextPaths.has(path))
      .map(path => ({
        path: joinGitPath(root, path),
        sha: null,
      }))
    const tree = await this.#github<{ sha: string }>(`/repos/${owner}/${repo}/git/trees`, {
      body: JSON.stringify({
        base_tree: current.tree.sha,
        tree: [
          ...files.map((file, index) => ({
            mode: "100644",
            path: joinGitPath(root, file.path),
            sha: blobs[index]!.sha,
            type: "blob",
          })),
          ...deletedEntries,
        ],
      }),
      method: "POST",
    })
    const commit = await this.#github<{ sha: string }>(`/repos/${owner}/${repo}/git/commits`, {
      body: JSON.stringify({
        message: options.name || "chore: update workspace snapshot",
        parents: [ref.object.sha],
        tree: tree.sha,
      }),
      method: "POST",
    })
    await this.#github(refsPath, {
      body: JSON.stringify({ sha: commit.sha }),
      method: "PATCH",
    })

    const snapshot = await this.#snapshot(commit.sha, options.name)
    const committed = {
      ...snapshot,
      files: files.map(file => joinGitPath(root, file.path)),
      sha: commit.sha,
      url: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
    }
    this.#baseline = committed
    return committed
  }

  async diff(options: DiffOptions = {}): Promise<WorkspaceDiff> {
    const from = options.from || this.#baseline
    const to = await this.#snapshot()
    const entries: WorkspaceDiff["entries"] = []
    const keys = new Set([...Object.keys(from?.entries || {}), ...Object.keys(to.entries)])

    for (const path of [...keys].sort()) {
      const before = from?.entries[path]
      const after = to.entries[path]
      if (!before && after) entries.push({ after, path, type: "added" })
      else if (before && !after) entries.push({ before, path, type: "removed" })
      else if (before && after && (before.digest !== after.digest || before.type !== after.type || before.size !== after.size)) {
        entries.push({ after, before, path, type: "modified" })
      }
    }
    return { entries, from: from?.id, to: to.id }
  }

  async getMeta(key: string): Promise<unknown> {
    return this.#meta.get(key)
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    this.#meta.set(key, value)
  }

  async #entry(file: GitHubWorkspaceFile): Promise<WorkspaceStat> {
    return {
      digest: await sha256(file.content),
      mediaType: file.mediaType,
      mtime: file.mtime,
      path: file.path,
      size: fileSize(file),
      type: "file",
    }
  }

  async #snapshot(id = `github-${Date.now().toString(36)}`, name?: string): Promise<WorkspaceSnapshot> {
    const entries = Object.fromEntries(await Promise.all([...this.#files.values()].map(async file => [file.path, {
      digest: await sha256(file.content),
      size: fileSize(file),
      type: "file" as const,
    }])))
    return {
      createdAt: new Date().toISOString(),
      entries,
      id,
      name,
    }
  }

  async #github<T>(path: string, init?: RequestInit): Promise<T> {
    const token = resolveOption(this.options.token)
    if (!token) throw new WorkspaceError("[vitehub] GitHub workspace store requires a token.")
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        ...init?.headers,
      },
    })

    if (!response.ok) {
      throw new WorkspaceError(`[vitehub] GitHub workspace store request failed: ${response.status} ${response.statusText} ${await response.text().catch(() => "")}`)
    }
    return await response.json() as T
  }
}

export function createGitHubWorkspaceStore(options: GitHubWorkspaceStoreResolvedOptions): WorkspaceStore {
  return new GitHubWorkspaceStore(options)
}

export function normalizeGitHubWorkspaceStoreOptions(
  options: GitHubWorkspaceStoreOptions,
  workspaceName: string,
  env: Record<string, string | undefined> = process.env,
): GitHubWorkspaceStoreResolvedOptions {
  return {
    branch: options.branch || env.WORKSPACE_GITHUB_BRANCH || env.VITEHUB_WORKSPACE_GITHUB_BRANCH || env.GITHUB_BRANCH || "main",
    repo: options.repository || options.repo || env.WORKSPACE_GITHUB_REPOSITORY || env.VITEHUB_WORKSPACE_GITHUB_REPOSITORY || env.GITHUB_REPOSITORY || "",
    root: options.root || env.WORKSPACE_GITHUB_ROOT || env.VITEHUB_WORKSPACE_GITHUB_ROOT || `.vitehub/workspaces/${workspaceName}`,
    token: options.token || env.WORKSPACE_GITHUB_TOKEN || env.VITEHUB_WORKSPACE_GITHUB_TOKEN || env.GITHUB_TOKEN || "",
  }
}
