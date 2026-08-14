import { Buffer } from "node:buffer"
import { defineCachedFunction } from "ocache"

import { isSourceError, sourceError } from "../../core/errors.ts"
import { normalizeSourcePath } from "../../core/path.ts"
import { matchesAny } from "../path.ts"
import { parseGitHubArchive } from "./archive.ts"
import { createGitHubCacheKey, normalizeGitHubCache } from "./cache.ts"
import { fetchGitHubArchive, requestGitHubJson } from "./client.ts"
import { getGitSparsePatterns, loadGitArchiveFiles } from "./git.ts"

import type { Source, SourceContext } from "../../core/types.ts"
import type { GitHubCommitResponse, GitHubContentResponse, GitHubFile, GitHubRepositoryResponse, GitHubSourceOptions } from "./types.ts"

function normalizeGitHubRoot(path = "") {
  return normalizeSourcePath(path).split("/").filter(part => part && part !== ".").join("/")
}

function dedupeProviderPromise<TResult>(
  promises: Map<string, Promise<TResult>>,
  key: string,
  load: () => Promise<TResult>,
) {
  const promise = promises.get(key)
  if (promise) return promise
  const nextPromise = load().finally(() => {
    promises.delete(key)
  })
  promises.set(key, nextPromise)
  return nextPromise
}

export function github<const TKey extends string = string>(options: GitHubSourceOptions): Source<TKey> {
  const configuredRef = options.ref
  const root = normalizeGitHubRoot(options.root || "")
  const sparsePatterns = getGitSparsePatterns(root, options.include)
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

  function repoPathForKey(key: string) {
    const normalized = normalizeSourcePath(key)
    return root ? `${root}/${normalized}` : normalized
  }

  function contentsUrl(repoPath: string, ref: string) {
    return `https://api.github.com/repos/${options.repo}/contents/${encodeURIComponent(repoPath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`
  }

  function shouldInclude(key: string) {
    if (options.include && !matchesAny(key, options.include)) return false
    if (options.exclude && matchesAny(key, options.exclude)) return false
    return true
  }

  async function resolveRef(token = auth, signal?: AbortSignal) {
    if (configuredRef) return configuredRef

    try {
      const repo = await requestGitHubJson<GitHubRepositoryResponse>({
        ref: "default",
        repo: options.repo,
        signal,
        token,
        url: `https://api.github.com/repos/${options.repo}`,
      })
      const defaultBranch = repo.default_branch || "main"
      const commit = await requestGitHubJson<GitHubCommitResponse>({
        ref: defaultBranch,
        repo: options.repo,
        signal,
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
    return isSourceError(error) && error instanceof Error && error.message.includes(" request failed with 403 ")
  }

  const resolvedRefs = new Map<string, Promise<string>>()
  const cachedResolveRef = providerCache
    ? defineCachedFunction(
        async (token: string | undefined) => await resolveRef(token),
        {
          ...providerCache,
          getKey: token => cacheKey("ref", token || ""),
          name: "github-source-ref",
        },
      )
    : (token: string | undefined) => dedupeProviderPromise(
        resolvedRefs,
        cacheKey("ref", token || ""),
        () => resolveRef(token),
      )

  async function getRef(token = refreshAuth(), signal?: AbortSignal) {
    return signal ? await resolveRef(token, signal) : await cachedResolveRef(token)
  }

  async function validateConfiguredRef(token = auth, signal?: AbortSignal): Promise<void> {
    if (!configuredRef) return
    await requestGitHubJson<GitHubCommitResponse>({
      ref: configuredRef,
      repo: options.repo,
      signal,
      token,
      url: `https://api.github.com/repos/${options.repo}/commits/${encodeURIComponent(configuredRef)}`,
    })
  }

  async function loadArchiveFiles(token = auth, signal?: AbortSignal, resolvedRef?: string) {
    const ref = resolvedRef ?? await getRef(token, signal)
    const archive = await fetchGitHubArchive({ ref, repo: options.repo, signal, token })
    return parseGitHubArchive(archive)
      .map((entry): GitHubFile<TKey> | undefined => {
        const key = keyForRepoPath(entry.path)
        if (!key || !shouldInclude(key)) return undefined
        return {
          content: entry.content,
          key,
          path: key,
          ref,
          sha: ref,
        }
      })
      .filter((file): file is GitHubFile<TKey> => Boolean(file))
  }

  async function loadFiles(token = auth, signal?: AbortSignal) {
    const ref = await getRef(token, signal)
    if (sparsePatterns) {
      try {
        return await loadGitArchiveFiles({
          keyForRepoPath,
          ref,
          repo: options.repo,
          shouldInclude,
          signal,
          sparsePatterns,
          token,
        })
      }
      catch (error) {
        if (signal?.aborted) throw error
      }
    }
    return await loadArchiveFiles(token, signal, ref)
  }

  const loadedFiles = new Map<string, Promise<GitHubFile<TKey>[]>>()
  const cachedLoadFiles = providerCache
    ? defineCachedFunction(
        async (token: string | undefined) => await loadFiles(token),
        {
          ...providerCache,
          getKey: token => cacheKey("archive", token || ""),
          name: "github-source-archive",
        },
      )
    : (token: string | undefined) => dedupeProviderPromise(
        loadedFiles,
        cacheKey("archive", token || ""),
        () => loadFiles(token),
      )

  function getFiles(token = refreshAuth(), signal?: AbortSignal) {
    return signal ? loadFiles(token, signal) : cachedLoadFiles(token)
  }

  async function loadFileMetadata(key: TKey, token = auth, signal?: AbortSignal): Promise<GitHubFile<TKey> | undefined> {
    const normalizedKey = normalizeSourcePath(key) as TKey
    if (!normalizedKey || !shouldInclude(normalizedKey)) return
    const ref = await getRef(token, signal)
    const repoPath = repoPathForKey(normalizedKey)
    let file: GitHubContentResponse | GitHubContentResponse[] | undefined
    try {
      file = await requestGitHubJson<GitHubContentResponse | GitHubContentResponse[]>({
        ref,
        repo: options.repo,
        signal,
        token,
        url: contentsUrl(repoPath, ref),
      })
    }
    catch (error) {
      if (isGitHubAccessError(error)) {
        await validateConfiguredRef(token, signal)
        return
      }
      if (shouldResolveMainFallback(error)) {
        const files = signal ? await loadArchiveFiles(token, signal, ref) : await getFiles(token)
        return files.find(file => file.key === normalizedKey)
      }
      throw error
    }
    if (!file || Array.isArray(file)) return
    if (file.type === "dir") return
    return {
      key: normalizedKey,
      path: normalizedKey,
      ref,
      sha: file.sha || ref,
    }
  }

  const loadedFileMetadata = new Map<string, Promise<GitHubFile<TKey> | undefined>>()
  const cachedLoadFileMetadata = providerCache
    ? defineCachedFunction(
        async (key: TKey, token: string | undefined) => await loadFileMetadata(key, token),
        {
          ...providerCache,
          getKey: (key, token) => cacheKey("metadata", token || "", key),
          name: "github-source-metadata",
        },
      )
    : (key: TKey, token: string | undefined) => dedupeProviderPromise(
        loadedFileMetadata,
        cacheKey("metadata", token || "", key),
        () => loadFileMetadata(key, token),
      )

  function isGitHubAccessError(error: unknown) {
    return isSourceError(error) && error instanceof Error && error.message.includes(" could not access the repository or ref ")
  }

  async function loadFile(key: TKey, token = auth, signal?: AbortSignal): Promise<GitHubFile<TKey>> {
    const normalizedKey = normalizeSourcePath(key) as TKey
    if (!normalizedKey || !shouldInclude(normalizedKey)) {
      throw sourceError(`[vitehub] github(${JSON.stringify(options.repo)}) could not find ${JSON.stringify(key)}.`)
    }
    const ref = await getRef(token, signal)
    const repoPath = repoPathForKey(normalizedKey)
    const file = await requestGitHubJson<GitHubContentResponse | GitHubContentResponse[]>({
      ref,
      repo: options.repo,
      signal,
      token,
      url: contentsUrl(repoPath, ref),
    })
    if (Array.isArray(file) || file.type === "dir") {
      throw sourceError(`[vitehub] github(${JSON.stringify(options.repo)}) expected ${JSON.stringify(key)} to be a file, but it is a directory.`)
    }
    if (file.encoding !== "base64" || typeof file.content !== "string") {
      throw sourceError(`[vitehub] github(${JSON.stringify(options.repo)}) did not include file content for ${JSON.stringify(key)}.`)
    }
    return {
      content: new Uint8Array(Buffer.from(file.content.replace(/\s/g, ""), "base64")),
      key: normalizedKey,
      path: normalizedKey,
      ref,
      sha: file.sha || ref,
    }
  }

  async function getFile(key: TKey, ctx?: SourceContext, token = refreshAuth()) {
    if (ctx?.abortSignal) return await loadFile(key, token, ctx.abortSignal)
    const file = (await getFiles(token)).find(file => file.key === key)
    if (!file) {
      throw sourceError(`[vitehub] github(${JSON.stringify(options.repo)}) could not find ${JSON.stringify(key)}.`)
    }
    return file
  }

  function fetchContent(key: TKey, file: GitHubFile<TKey>) {
    if (file.content) return Promise.resolve(file.content)
    throw sourceError(`[vitehub] github(${JSON.stringify(options.repo)}) did not include archive content for ${JSON.stringify(key)}.`)
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
    fingerprint: {
      exclude: options.exclude,
      include: options.include,
      ref: configuredRef || "default",
      repo: options.repo,
      root,
    },
    name: "github",
    async getKeys(ctx) {
      return (await getFiles(refreshAuth(), ctx.abortSignal)).map(file => file.key)
    },
    async getItems(ctx) {
      const token = refreshAuth()
      return await Promise.all((await getFiles(token, ctx.abortSignal)).map(async file => ({
        key: file.key,
        path: file.path,
        content: await fetchContent(file.key, file),
        metadata: {
          ref: file.ref,
          sha: file.sha,
        },
      })))
    },
    async getMeta(key, ctx) {
      const token = refreshAuth()
      const file = ctx?.abortSignal
        ? await loadFileMetadata(key, token, ctx.abortSignal)
        : await cachedLoadFileMetadata(key, token)
      if (!file) return
      return {
        ref: file.ref,
        sha: file.sha,
      }
    },
    async getItem(key, ctx) {
      const token = refreshAuth()
      const file = await getFile(key, ctx, token)
      return {
        key: file.key,
        path: file.path,
        content: await fetchContent(key, file),
        metadata: {
          ref: file.ref,
          sha: file.sha,
        },
      }
    },
  }
}
