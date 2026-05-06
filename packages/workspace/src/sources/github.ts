import { Buffer } from "node:buffer"
import { gunzipSync } from "node:zlib"

import { getActiveCloudflareBinding } from "@vitehub/internal/runtime/cloudflare-env"
import { defineCachedFunction } from "ocache"

import { WorkspaceError } from "../errors.ts"
import { matchesAny, normalizeWorkspacePath } from "../path.ts"
import type { WorkspaceCacheOptions, WorkspaceSource } from "../types.ts"

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
  content?: Uint8Array
  key: string
  path: string
  sha: string | undefined
}

interface GitHubArchiveFile {
  content: Uint8Array
  path: string
}

export function github(options: GitHubSourceOptions): WorkspaceSource {
  const ref = options.ref || "main"
  const root = normalizeWorkspacePath(options.root || "")
  let auth: string | undefined
  const providerCache = normalizeProviderCache(options)

  function resolveAuth(): string | undefined {
    const token = options.auth || getActiveCloudflareBinding<string>("GITHUB_TOKEN") || process.env.GITHUB_TOKEN
    return typeof token === "string" && token.length > 0 ? token : undefined
  }

  function refreshAuth(): string | undefined {
    const nextAuth = resolveAuth()
    if (nextAuth !== auth) {
      auth = nextAuth
    }
    return auth
  }

  async function request<T>(url: string, token = auth): Promise<T> {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
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

  async function requestRawContent(repoPath: string, encodedPath: string, token: string) {
    const response = await fetch(
      `https://api.github.com/repos/${options.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      {
        headers: {
          accept: "application/vnd.github.raw+json",
          authorization: `Bearer ${token}`,
          "user-agent": "vitehub-workspace",
          "x-github-api-version": "2022-11-28",
        },
      },
    )
    if (!response.ok) {
      if (response.status === 404) {
        throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) could not find ${JSON.stringify(repoPath)} at ref ${JSON.stringify(ref)}.`)
      }
      throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) raw content request failed with ${response.status} for ${repoPath}.`)
    }
    const content = new Uint8Array(await response.arrayBuffer())
    rejectUnsupportedRawContentPayload(repoPath, response.headers.get("content-type"), content)
    return content
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

  async function loadTreeFiles() {
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

  async function loadArchiveFiles() {
    const response = await fetch(`https://codeload.github.com/${options.repo}/tar.gz/${encodeURIComponent(ref)}`, {
      headers: {
        "user-agent": "vitehub-workspace",
      },
    })

    if (!response.ok) {
      if (response.status === 404) {
        throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) could not access the repository or ref ${JSON.stringify(ref)}. Check that the repo exists and the ref exists.`)
      }
      throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) archive request failed with ${response.status}.`)
    }

    return parseGitHubArchive(new Uint8Array(await response.arrayBuffer()))
      .map((entry): GitHubFile | undefined => {
        const key = keyForRepoPath(entry.path)
        if (!key || !shouldInclude(key)) return undefined
        return {
          content: entry.content,
          key,
          path: key,
          sha: undefined,
        }
      })
      .filter((file): file is GitHubFile => Boolean(file))
  }

  async function loadFiles(token = auth) {
    try {
      return await loadTreeFiles()
    }
    catch (error) {
      if (error instanceof WorkspaceError && error.message.includes(" request failed with 403 ")) {
        return await loadArchiveFiles()
      }
      throw error
    }
  }

  const cachedLoadFiles = defineCachedFunction(loadFiles, {
    ...providerCache,
    getKey: token => cacheKey("tree", token || ""),
    name: "github-source-tree",
  })

  function getFiles() {
    return cachedLoadFiles(refreshAuth())
  }

  function repoPathForKey(key: string) {
    return root ? `${root}/${key}` : key
  }

  function fetchContent(key: string, file: GitHubFile, token = auth) {
    if (file.content) return Promise.resolve(file.content)

    const repoPath = repoPathForKey(key)
    const encodedPath = encodeURIComponent(repoPath).replaceAll("%2F", "/")
    if (!token) {
      return fetchRawContent(repoPath, encodedPath)
    }
    return request<GitHubContentResponse>(
      `https://api.github.com/repos/${options.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      token,
    ).then((file) => {
      if (file.encoding !== "base64" || typeof file.content !== "string") {
        return requestRawContent(repoPath, encodedPath, token)
      }
      return new Uint8Array(Buffer.from(file.content, "base64"))
    })
  }

  const cachedFetchContent = defineCachedFunction(
    async (key: string, token: string | undefined) => {
      const file = (await getFiles()).find(file => file.key === key)
      if (!file) {
        throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) could not find ${JSON.stringify(key)}.`)
      }
      return await fetchContent(key, file, token)
    },
    {
      ...providerCache,
      getKey: (key, token) => cacheKey("content", token || "", key),
      name: "github-source-content",
    },
  )

  function cacheKey(kind: string, token: string, key = "") {
    return [
      kind,
      options.repo,
      ref,
      root,
      normalizePatternCacheKey(options.include),
      normalizePatternCacheKey(options.exclude),
      token,
      key,
    ].join(":")
  }

  async function fetchRawContent(repoPath: string, encodedPath: string, token = auth) {
    const response = await fetch(`https://raw.githubusercontent.com/${options.repo}/${encodeURIComponent(ref)}/${encodedPath}`, {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "user-agent": "vitehub-workspace",
      },
    })
    if (!response.ok) {
      if (response.status === 404) {
        throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) could not find ${JSON.stringify(repoPath)} at ref ${JSON.stringify(ref)}.`)
      }
      throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) raw content request failed with ${response.status} for ${repoPath}.`)
    }
    return new Uint8Array(await response.arrayBuffer())
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
      const token = refreshAuth()
      const file = (await getFiles()).find(file => file.key === key)
      if (!file) {
        throw new WorkspaceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) could not find ${JSON.stringify(key)}.`)
      }
      return {
        key,
        path: file.path,
        content: await cachedFetchContent(key, token),
      }
    },
  }
}

function normalizeProviderCache(options: Pick<WorkspaceSource, "cache" | "swr">): WorkspaceCacheOptions {
  if (options.cache === false) return { maxAge: 0, swr: false }
  if (options.cache && typeof options.cache === "object") {
    return {
      maxAge: options.cache.maxAge ?? 1,
      staleMaxAge: options.cache.staleMaxAge,
      swr: options.cache.swr ?? true,
    }
  }
  if (typeof options.swr === "number") return { maxAge: options.swr, swr: true }
  return { maxAge: 1, swr: options.swr === false ? false : true }
}

function normalizePatternCacheKey(value: string | string[] | undefined) {
  if (!value) return ""
  return Array.isArray(value) ? value.join(",") : value
}

function parseGitHubArchive(bytes: Uint8Array) {
  const tar = gunzipSync(bytes)
  const files: GitHubArchiveFile[] = []
  let offset = 0
  let paxPath: string | undefined

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break

    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const path = paxPath || [prefix, name].filter(Boolean).join("/")
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8) || 0
    const type = String.fromCharCode(header[156] || 0)
    const contentStart = offset + 512
    const contentEnd = contentStart + size
    const content = tar.subarray(contentStart, contentEnd)

    if (type === "x") {
      paxPath = readPaxPath(content)
    }
    else {
      if (type === "0" || type === "\0") {
        const entryPath = stripArchiveRoot(path)
        if (entryPath) {
          files.push({
            content: new Uint8Array(content),
            path: entryPath,
          })
        }
      }
      paxPath = undefined
    }

    offset = contentStart + Math.ceil(size / 512) * 512
  }

  return files
}

function readTarString(buffer: Uint8Array, offset: number, length: number) {
  const slice = buffer.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString("utf8")
}

function readPaxPath(content: Uint8Array) {
  const text = Buffer.from(content).toString("utf8")
  let index = 0
  while (index < text.length) {
    const space = text.indexOf(" ", index)
    if (space === -1) return
    const length = Number.parseInt(text.slice(index, space), 10)
    if (!length) return
    const record = text.slice(space + 1, index + length - 1)
    const equals = record.indexOf("=")
    if (equals !== -1 && record.slice(0, equals) === "path") return record.slice(equals + 1)
    index += length
  }
}

function stripArchiveRoot(path: string) {
  const slash = path.indexOf("/")
  if (slash === -1) return
  return normalizeWorkspacePath(path.slice(slash + 1))
}

function rejectUnsupportedRawContentPayload(repoPath: string, contentType: string | null, content: Uint8Array) {
  if (!contentType?.includes("json")) return

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(content).toString("utf8"))
  }
  catch {
    return
  }

  if (isGitHubContentsPayload(payload) && payload.type !== "file") {
    throw new WorkspaceError(`[vitehub] source.github raw content for ${JSON.stringify(repoPath)} resolved to unsupported GitHub content type ${JSON.stringify(payload.type)}.`)
  }
}

function isGitHubContentsPayload(value: unknown): value is { type: string } {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && typeof (value as { type?: unknown }).type === "string"
    && ("download_url" in value || "git_url" in value || "html_url" in value || "url" in value)
}
