import { Buffer } from "node:buffer"

import { WorkspaceError } from "../errors.ts"
import { matchesAny, normalizeWorkspacePath } from "../path.ts"
import type { WorkspaceSource } from "../types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "swr" | "validate">

export interface GitHubSourceOptions extends SourceRuntimeOptions {
  repo: string
  ref?: string
  root?: string
  auth?: string
  include?: string | string[]
  exclude?: string | string[]
}

interface GitHubTreeItem {
  path: string
  sha?: string
  type: "blob" | "tree"
}

interface GitHubTreeResponse {
  sha: string
  tree: GitHubTreeItem[]
  truncated?: boolean
}

interface GitHubContentResponse {
  content?: string
  encoding?: string
}

interface GitHubFile {
  key: string
  path: string
  sha: string | undefined
}

export function github(options: GitHubSourceOptions): WorkspaceSource {
  const ref = options.ref || "main"
  const root = normalizeWorkspacePath(options.root || "")
  let filesPromise: Promise<GitHubFile[]> | undefined
  const contentPromises = new Map<string, Promise<Uint8Array>>()

  async function request<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        ...(options.auth ? { authorization: `Bearer ${options.auth}` } : {}),
        "user-agent": "vitehub-workspace",
        "x-github-api-version": "2022-11-28",
      },
    })

    if (!response.ok) {
      if (response.status === 404) {
        throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) could not access the repository or ref ${JSON.stringify(ref)}. Check that the repo exists, the ref exists, and auth can access it.`)
      }
      throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) request failed with ${response.status} for ${url}.`)
    }

    return await response.json() as T
  }

  function keyForRepoPath(path: string) {
    const normalized = normalizeWorkspacePath(path)
    if (!root) return normalized
    if (!normalized.startsWith(`${root}/`)) return undefined
    return normalized.slice(root.length + 1)
  }

  function shouldInclude(key: string) {
    if (options.include && !matchesAny(key, options.include)) return false
    if (options.exclude && matchesAny(key, options.exclude)) return false
    return true
  }

  async function loadFiles() {
    const tree = await request<GitHubTreeResponse>(
      `https://api.github.com/repos/${options.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    )

    if (tree.truncated) {
      throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) received a truncated tree for ref ${JSON.stringify(ref)}.`)
    }

    return tree.tree
      .filter(item => item.type === "blob")
      .map((item): GitHubFile | undefined => {
        const key = keyForRepoPath(item.path)
        if (!key || !shouldInclude(key)) return undefined
        return {
          key,
          path: key,
          sha: item.sha,
        }
      })
      .filter((file): file is GitHubFile => Boolean(file))
  }

  function getFiles() {
    if (!filesPromise) filesPromise = loadFiles()
    return filesPromise
  }

  function repoPathForKey(key: string) {
    return root ? `${root}/${key}` : key
  }

  function fetchContent(key: string) {
    const repoPath = repoPathForKey(key)
    const encodedPath = encodeURIComponent(repoPath).replaceAll("%2F", "/")
    return request<GitHubContentResponse>(
      `https://api.github.com/repos/${options.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    ).then((file) => {
      if (file.encoding !== "base64" || typeof file.content !== "string") {
        throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) received unsupported content for ${JSON.stringify(repoPath)}.`)
      }
      return new Uint8Array(Buffer.from(file.content, "base64"))
    })
  }

  return {
    cache: options.cache,
    materialize: options.materialize,
    mount: options.mount,
    name: "github",
    swr: options.swr,
    validate: options.validate,
    async getKeys() {
      return (await getFiles()).map(file => file.key)
    },
    async getMeta(key) {
      const file = (await getFiles()).find(file => file.key === key)
      if (!file) return
      return {
        ref,
        sha: file.sha,
      }
    },
    async getItem(key) {
      const file = (await getFiles()).find(file => file.key === key)
      if (!file) {
        throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) could not find ${JSON.stringify(key)}.`)
      }
      const contentPromise = contentPromises.get(key) || fetchContent(key)
      contentPromises.set(key, contentPromise)
      return {
        key,
        path: file.path,
        content: await contentPromise,
      }
    },
  }
}
