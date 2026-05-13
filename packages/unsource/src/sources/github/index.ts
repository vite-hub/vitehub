import { defineCachedFunction } from "ocache"

import { UnsourceError } from "../../core/errors.ts"
import { matchesAny, normalizeSourcePath } from "../../core/path.ts"
import { parseGitHubArchive } from "./archive.ts"
import { createGitHubCacheKey, normalizeGitHubCache } from "./cache.ts"
import { fetchGitHubArchive, requestGitHubJson } from "./client.ts"

import type { Source } from "../../core/types.ts"
import type { GitHubCommitResponse, GitHubFile, GitHubRepositoryResponse, GitHubSourceOptions } from "./types.ts"

function normalizeGitHubRoot(path = "") {
  return normalizeSourcePath(path).split("/").filter(part => part && part !== ".").join("/")
}

export function github<const TKey extends string = string>(options: GitHubSourceOptions): Source<TKey> {
  const configuredRef = options.ref
  const root = normalizeGitHubRoot(options.root || "")
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

  async function resolveRef(token = auth) {
    if (configuredRef) return configuredRef

    try {
      const repo = await requestGitHubJson<GitHubRepositoryResponse>({
        ref: "default",
        repo: options.repo,
        token,
        url: `https://api.github.com/repos/${options.repo}`,
      })
      const defaultBranch = repo.default_branch || "main"
      const commit = await requestGitHubJson<GitHubCommitResponse>({
        ref: defaultBranch,
        repo: options.repo,
        token,
        url: `https://api.github.com/repos/${options.repo}/commits/${encodeURIComponent(defaultBranch)}`,
      })
      return commit.sha || defaultBranch
    }
    catch (error) {
      if (shouldResolveMainFallback(error)) return "main"
      throw error
    }
  }

  function shouldResolveMainFallback(error: unknown) {
    return error instanceof UnsourceError && error.message.includes(" request failed with 403 ")
  }

  const cachedResolveRef = providerCache
    ? defineCachedFunction(
        async (token: string | undefined) => await resolveRef(token),
        {
          ...providerCache,
          getKey: token => cacheKey("ref", token || ""),
          name: "github-source-ref",
        },
      )
    : async (token: string | undefined) => await resolveRef(token)

  async function getRef(token = refreshAuth()) {
    return await cachedResolveRef(token)
  }

  async function loadArchiveFiles(token = auth) {
    const ref = await getRef(token)
    const archive = await fetchGitHubArchive({ ref, repo: options.repo, token })
    return parseGitHubArchive(archive)
      .map((entry): GitHubFile<TKey> | undefined => {
        const key = keyForRepoPath(entry.path)
        if (!key || !shouldInclude(key)) return undefined
        return {
          content: entry.content,
          key,
          path: key,
          sha: ref,
        }
      })
      .filter((file): file is GitHubFile<TKey> => Boolean(file))
  }

  async function loadFiles(token = auth) {
    return await loadArchiveFiles(token)
  }

  const cachedLoadFiles = providerCache
    ? defineCachedFunction(
        async (token: string | undefined) => await loadFiles(token),
        {
          ...providerCache,
          getKey: token => cacheKey("archive", token || ""),
          name: "github-source-archive",
        },
      )
    : async (token: string | undefined) => await loadFiles(token)

  function getFiles(token = refreshAuth()) {
    return cachedLoadFiles(token)
  }

  function fetchContent(key: TKey, file: GitHubFile<TKey>) {
    if (file.content) return Promise.resolve(file.content)
    throw new UnsourceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) did not include archive content for ${JSON.stringify(key)}.`)
  }

  async function getContent(key: TKey, token: string | undefined) {
    const file = (await getFiles(token)).find(file => file.key === key)
    if (!file) {
      throw new UnsourceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) could not find ${JSON.stringify(key)}.`)
    }
    return await fetchContent(key, file)
  }

  function cacheKey(kind: string, token: string, key = "") {
    return createGitHubCacheKey({
      exclude: options.exclude,
      include: options.include,
      key,
      kind,
      ref: configuredRef || "default",
      repo: options.repo,
      root,
      token,
    })
  }

  return {
    cache: options.cache,
    name: "github",
    async getKeys() {
      return (await getFiles()).map(file => file.key)
    },
    async getItems() {
      const token = refreshAuth()
      const ref = await getRef(token)
      return await Promise.all((await getFiles(token)).map(async file => ({
        key: file.key,
        path: file.path,
        content: await fetchContent(file.key, file),
        metadata: {
          ref,
          sha: file.sha,
        },
      })))
    },
    async getMeta(key) {
      const token = refreshAuth()
      const file = (await getFiles(token)).find(file => file.key === key)
      if (!file) return
      return {
        ref: await getRef(token),
        sha: file.sha,
      }
    },
    async getItem(key) {
      const token = refreshAuth()
      const file = (await getFiles(token)).find(file => file.key === key)
      if (!file) {
        throw new UnsourceError(`[vitehub] source.github(${JSON.stringify(options.repo)}) could not find ${JSON.stringify(key)}.`)
      }
      return {
        key,
        path: file.path,
        content: await getContent(key, token),
        metadata: {
          ref: await getRef(token),
          sha: file.sha,
        },
      }
    },
  }
}
