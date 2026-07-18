import { Buffer } from "node:buffer"
import { defineCachedFunction } from "ocache"

import {
  SourceError,
  sourceContentMissingError,
  sourceItemIsDirectoryError,
  sourceItemNotFoundError,
  sourceProviderResponseInvalidError,
} from "../../core/errors.ts"
import { matchesAny, normalizeSourcePath } from "../../core/path.ts"
import { parseGitHubArchive } from "./archive.ts"
import { createGitHubCacheKey, normalizeGitHubCache } from "./cache.ts"
import { fetchGitHubArchive, requestGitHubJson } from "./client.ts"
import { getGitSparsePatterns, loadGitArchiveFiles } from "./git.ts"

import type { Source, SourceContext } from "../../core/types.ts"
import type { GitHubCommitResponse, GitHubContentResponse, GitHubFile, GitHubRepositoryResponse, GitHubSourceOptions } from "./types.ts"

function normalizeGitHubRoot(path = "") {
  return normalizeSourcePath(path).split("/").filter(part => part && part !== ".").join("/")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readRequiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field]
  if (typeof result !== "string" || !result) throw new TypeError(`GitHub response has an invalid ${field}.`)
  return result
}

function decodeRepositoryResponse(value: unknown): GitHubRepositoryResponse {
  if (!isRecord(value)) throw new TypeError("GitHub repository response must be an object.")
  return { default_branch: readRequiredString(value, "default_branch") }
}

function decodeCommitResponse(value: unknown): GitHubCommitResponse {
  if (!isRecord(value)) throw new TypeError("GitHub commit response must be an object.")
  return { sha: readRequiredString(value, "sha") }
}

function decodeContentEntry(value: unknown): GitHubContentResponse {
  if (!isRecord(value)) throw new TypeError("GitHub content response must be an object.")
  const type = readRequiredString(value, "type")
  for (const field of ["content", "encoding", "path", "sha"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new TypeError(`GitHub content response has an invalid ${field}.`)
    }
  }
  return {
    ...(value.content === undefined ? {} : { content: value.content as string }),
    ...(value.encoding === undefined ? {} : { encoding: value.encoding as string }),
    ...(value.path === undefined ? {} : { path: value.path as string }),
    ...(value.sha === undefined ? {} : { sha: value.sha as string }),
    type,
  }
}

function decodeContentResponse(value: unknown): GitHubContentResponse | GitHubContentResponse[] {
  return Array.isArray(value) ? value.map(decodeContentEntry) : decodeContentEntry(value)
}

function decodeBase64Content(value: string) {
  const normalized = value.replace(/\s/g, "")
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}(?:==)?|[A-Za-z\d+/]{3}=?|)$/.test(normalized)) {
    throw new TypeError("GitHub content response has invalid base64 content.")
  }
  return new Uint8Array(Buffer.from(normalized, "base64"))
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
        decode: decodeRepositoryResponse,
        operation: "resolve-repository",
        signal,
        token,
        url: `https://api.github.com/repos/${options.repo}`,
      })
      const defaultBranch = repo.default_branch
      const commit = await requestGitHubJson<GitHubCommitResponse>({
        decode: decodeCommitResponse,
        operation: "resolve-ref",
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
    return error instanceof SourceError
      && error.code === "SOURCE_PROVIDER_REQUEST_FAILED"
      && error.details?.provider === "github"
      && error.details.status === 403
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
      decode: decodeCommitResponse,
      operation: "validate-ref",
      signal,
      token,
      url: `https://api.github.com/repos/${options.repo}/commits/${encodeURIComponent(configuredRef)}`,
    })
  }

  async function loadArchiveFiles(token = auth, signal?: AbortSignal, resolvedRef?: string) {
    const ref = resolvedRef ?? await getRef(token, signal)
    const archive = await fetchGitHubArchive({ ref, repo: options.repo, signal, token })
    let entries: ReturnType<typeof parseGitHubArchive>
    try {
      entries = parseGitHubArchive(archive)
    }
    catch (cause) {
      throw sourceProviderResponseInvalidError("github", "read-archive", { cause })
    }
    return entries
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
        decode: decodeContentResponse,
        operation: "read-metadata",
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
    return error instanceof SourceError
      && error.code === "SOURCE_PROVIDER_REQUEST_FAILED"
      && error.details?.provider === "github"
      && error.details.status === 404
  }

  async function loadFile(key: TKey, token = auth, signal?: AbortSignal): Promise<GitHubFile<TKey>> {
    const normalizedKey = normalizeSourcePath(key) as TKey
    if (!normalizedKey || !shouldInclude(normalizedKey)) {
      throw sourceItemNotFoundError("github", key)
    }
    const ref = await getRef(token, signal)
    const repoPath = repoPathForKey(normalizedKey)
    let file: GitHubContentResponse | GitHubContentResponse[]
    try {
      file = await requestGitHubJson<GitHubContentResponse | GitHubContentResponse[]>({
        decode: decodeContentResponse,
        operation: "read-item",
        signal,
        token,
        url: contentsUrl(repoPath, ref),
      })
    }
    catch (error) {
      if (isGitHubAccessError(error)) {
        await validateConfiguredRef(token, signal)
        throw sourceItemNotFoundError("github", key)
      }
      throw error
    }
    if (Array.isArray(file) || file.type === "dir") {
      throw sourceItemIsDirectoryError("github", key)
    }
    if (file.encoding !== "base64" || typeof file.content !== "string") {
      throw sourceContentMissingError("github", key)
    }
    let content: Uint8Array
    try {
      content = decodeBase64Content(file.content)
    }
    catch (cause) {
      throw sourceProviderResponseInvalidError("github", "read-item", { cause })
    }
    return {
      content,
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
      throw sourceItemNotFoundError("github", key)
    }
    return file
  }

  function fetchContent(key: TKey, file: GitHubFile<TKey>) {
    if (file.content) return Promise.resolve(file.content)
    throw sourceContentMissingError("github", key)
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
