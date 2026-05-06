import { Buffer } from "node:buffer"

import { defineCachedFunction } from "ocache"

import { UnsourceError } from "../../core/errors.ts"
import { matchesAny, normalizeSourcePath } from "../../core/path.ts"
import { parseGitHubArchive } from "./archive.ts"
import { createGitHubCacheKey, normalizeGitHubCache } from "./cache.ts"
import { fetchGitHubArchive, fetchGitHubRawContent, requestGitHubJson } from "./client.ts"

import type { Source } from "../../core/types.ts"
import type { GitHubContentResponse, GitHubFile, GitHubSourceOptions, GitHubTreeResponse } from "./types.ts"

export function github<const TKey extends string = string>(options: GitHubSourceOptions): Source<TKey> {
  const ref = options.ref || "main"
  const root = normalizeSourcePath(options.root || "")
  let auth: string | undefined
  const providerCache = normalizeGitHubCache(options)

  function resolveAuth(): string | undefined {
    const token = typeof options.auth === "function" ? options.auth() : options.auth
    return typeof token === "string" && token.length > 0 ? token : undefined
  }

  function refreshAuth(): string | undefined {
    const nextAuth = resolveAuth()
    if (nextAuth !== auth) {
      auth = nextAuth
    }
    return auth
  }

  function keyForRepoPath(path: string) {
    const normalized = normalizeSourcePath(path)
    if (!root) return normalized as TKey
    if (!normalized.startsWith(`${root}/`)) return undefined
    return normalized.slice(root.length + 1) as TKey
  }

  function shouldInclude(key: string) {
    if (options.include && !matchesAny(key, options.include)) return false
    if (options.exclude && matchesAny(key, options.exclude)) return false
    return true
  }

  async function loadTreeFiles(token = auth) {
    const tree = await requestGitHubJson<GitHubTreeResponse>({
      ref,
      repo: options.repo,
      token,
      url: `https://api.github.com/repos/${options.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    })

    if (tree.truncated) {
      throw new UnsourceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) received a truncated tree for ref ${JSON.stringify(ref)}.`)
    }

    return tree.tree
      .filter(item => item.type === "blob")
      .map((item): GitHubFile<TKey> | undefined => {
        const key = keyForRepoPath(item.path)
        if (!key || !shouldInclude(key)) return undefined
        return {
          key,
          path: key,
          sha: item.sha,
        }
      })
      .filter((file): file is GitHubFile<TKey> => Boolean(file))
  }

  async function loadArchiveFiles(token = auth) {
    const archive = await fetchGitHubArchive({ ref, repo: options.repo, token })
    return parseGitHubArchive(archive)
      .map((entry): GitHubFile<TKey> | undefined => {
        const key = keyForRepoPath(entry.path)
        if (!key || !shouldInclude(key)) return undefined
        return {
          content: entry.content,
          key,
          path: key,
          sha: undefined,
        }
      })
      .filter((file): file is GitHubFile<TKey> => Boolean(file))
  }

  async function loadFiles(token = auth) {
    try {
      return await loadTreeFiles(token)
    }
    catch (error) {
      if (error instanceof UnsourceError && error.message.includes(" request failed with 403 ")) {
        return await loadArchiveFiles(token)
      }
      throw error
    }
  }

  const cachedLoadFiles = defineCachedFunction(
    async (token: string | undefined) => await loadFiles(token),
    {
      ...providerCache,
      getKey: token => cacheKey("tree", token || ""),
      name: "github-source-tree",
    },
  )

  function getFiles() {
    return cachedLoadFiles(refreshAuth())
  }

  function repoPathForKey(key: string) {
    return root ? `${root}/${key}` : key
  }

  function fetchContent(key: TKey, file: GitHubFile<TKey>, token = auth) {
    if (file.content) return Promise.resolve(file.content)

    const repoPath = repoPathForKey(key)
    const encodedPath = encodeURIComponent(repoPath).replaceAll("%2F", "/")
    if (!token) {
      return fetchRawContent(repoPath, encodedPath)
    }
    return requestGitHubJson<GitHubContentResponse>(
      {
        ref,
        repo: options.repo,
        token,
        url: `https://api.github.com/repos/${options.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      },
    ).then((file) => {
      if (file.encoding !== "base64" || typeof file.content !== "string") {
        return fetchRawContent(repoPath, encodedPath, token)
      }
      return new Uint8Array(Buffer.from(file.content, "base64"))
    })
  }

  const cachedFetchContent = defineCachedFunction(
    async (key: TKey, token: string | undefined) => {
      const file = (await getFiles()).find(file => file.key === key)
      if (!file) {
        throw new UnsourceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) could not find ${JSON.stringify(key)}.`)
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
    return createGitHubCacheKey({
      exclude: options.exclude,
      include: options.include,
      key,
      kind,
      ref,
      repo: options.repo,
      root,
      token,
    })
  }

  async function fetchRawContent(repoPath: string, encodedPath: string, token = auth) {
    return await fetchGitHubRawContent({ encodedPath, ref, repo: options.repo, repoPath, token })
  }

  return {
    cache: options.cache,
    name: "github",
    swr: options.swr,
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
        throw new UnsourceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) could not find ${JSON.stringify(key)}.`)
      }
      return {
        key,
        path: file.path,
        content: await cachedFetchContent(key, token),
      }
    },
  }
}
