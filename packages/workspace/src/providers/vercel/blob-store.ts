import { workspaceConflict, workspaceError } from "../../core/errors.ts"
import { contentToBytes, isExcludedWorkspacePath, normalizeSafeWorkspacePath, normalizeSafeWorkspacePattern, normalizeWorkspacePath, sha256 } from "../../core/path.ts"
import { createWorkspaceGlobMatcher } from "../../core/glob.ts"
import { ownedBlobPrefix } from "../../storage/owned-blob-prefix.ts"
import { resolveRuntimeVercelBlobWorkspaceStore } from "../../storage/provider.ts"
import { createCurrentSnapshotFromStore, diffSnapshots } from "../../storage/utils.ts"
import * as bundledVercelBlob from "@vercel/blob"

import type {
  DiffOptions,
  GlobOptions,
  ListOptions,
  MkdirOptions,
  RmOptions,
  SnapshotOptions,
  VercelBlobWorkspaceStoreOptions,
  WorkspaceDiff,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceSnapshot,
  WorkspaceStat,
  WorkspaceStore,
} from "../../core/types.ts"
import { workspaceErrorDiagnostics } from "../../error-diagnostics.ts"

type BlobListItem = {
  key: string
  size?: number
  lastModified?: number
  type?: string
}

type BlobListResult = {
  items: BlobListItem[]
  cursor?: string
  hasMore?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function invalidBlobListResponse(): never {
  throw workspaceErrorDiagnostics.WORKSPACE_R0033({ message: "Unexpected Vercel Blob list response." })
}

function parseBlobListResponse(value: unknown): BlobListResult {
  if (!isRecord(value) || !Array.isArray(value.blobs)) invalidBlobListResponse()
  const items = value.blobs.map((item: unknown): BlobListItem => {
    if (!isRecord(item)) invalidBlobListResponse()
    const pathname = item.pathname
    const size = item.size
    const uploadedAt = item.uploadedAt
    if (typeof pathname !== "string" || !pathname) invalidBlobListResponse()
    if (size !== undefined && (typeof size !== "number" || !Number.isFinite(size) || size < 0)) invalidBlobListResponse()
    if (uploadedAt !== undefined && (!(uploadedAt instanceof Date) || Number.isNaN(uploadedAt.getTime()))) invalidBlobListResponse()
    return {
      key: pathname,
      lastModified: uploadedAt instanceof Date ? uploadedAt.getTime() : undefined,
      size: typeof size === "number" ? size : undefined,
    }
  })
  const cursor = value.cursor
  const hasMore = value.hasMore
  if (cursor !== undefined && typeof cursor !== "string") invalidBlobListResponse()
  if (hasMore !== undefined && typeof hasMore !== "boolean") invalidBlobListResponse()
  if (hasMore === true && !cursor) invalidBlobListResponse()
  return {
    cursor: cursor === undefined ? undefined : cursor,
    hasMore: hasMore === undefined ? undefined : hasMore,
    items,
  }
}

type VercelBlobModule = {
  del(key: string, options?: { token?: string }): Promise<void>
  get(key: string, options: { access: "private" | "public", token?: string, useCache?: boolean, headers?: Record<string, string> }): Promise<{
    blob: { contentType: string, size: number }
    statusCode: 200
    stream: ReadableStream<Uint8Array>
  } | { statusCode: 304, stream: null } | null>
  head(key: string, options?: { token?: string }): Promise<{ contentType?: string, pathname: string, size: number, uploadedAt: Date }>
  list(options: { cursor?: string, limit?: number, prefix: string, token?: string }): Promise<{
    blobs: Array<{ pathname: string, size?: number, uploadedAt?: Date }>
    cursor?: string
    hasMore?: boolean
  }>
  put(key: string, body: Blob | Uint8Array | string, options: {
    access: "private" | "public"
    addRandomSuffix: boolean
    allowOverwrite: boolean
    contentType?: string
    token?: string
  }): Promise<unknown>
}

function isMissingBlobError(error: unknown) {
  return error instanceof Error && (
    error.name === "BlobNotFoundError"
    || /requested blob does not exist/i.test(error.message)
  )
}

function joinBlobPath(...parts: string[]) {
  return parts.map(part => normalizeWorkspacePath(part)).filter(Boolean).join("/")
}

function contentType(path: string, fallback?: string) {
  if (fallback) return fallback
  if (path.endsWith(".json")) return "application/json; charset=utf-8"
  if (path.endsWith(".md") || path.endsWith(".txt")) return "text/plain; charset=utf-8"
}

function auth(options: VercelBlobWorkspaceStoreOptions) {
  return options.token ? { token: options.token } : {}
}

function isNotFoundError(error: unknown): boolean {
  return Object(error).code === "NotFound"
}

async function createVercelBlobClient(options: VercelBlobWorkspaceStoreOptions) {
  const blob = await importVercelBlobPeer()
  const access = options.access || "private"
  return {
    async delete(key: string): Promise<void> {
      await blob.del(key, auth(options))
    },
    async download(key: string): Promise<Blob | undefined> {
      const readKey = access === "public"
        ? `${key}?vitehubCacheBust=${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        : key
      const result = await blob.get(readKey, {
        access,
        headers: { "cache-control": "no-cache, no-store" },
        useCache: false,
        ...auth(options),
      })
      if (!result) return undefined
      if (result.statusCode !== 200) throw workspaceErrorDiagnostics.WORKSPACE_R0033({ message: `Unexpected Vercel Blob response: ${result.statusCode}.` })
      return await new Response(result.stream, {
        headers: result.blob.contentType ? { "content-type": result.blob.contentType } : undefined,
      }).blob()
    },
    async head(key: string): Promise<BlobListItem | undefined> {
      const result = await blob.head(key, auth(options)).catch((error: unknown) => {
        if (isMissingBlobError(error)) return undefined
        throw error
      })
      if (!result) return undefined
      return {
        key: result.pathname,
        lastModified: result.uploadedAt.getTime(),
        size: result.size,
        type: result.contentType,
      }
    },
    async list(optionsInput: { cursor?: string, limit?: number, prefix: string }): Promise<BlobListResult> {
      const result: unknown = await blob.list({ ...optionsInput, ...auth(options) })
      const parsed = parseBlobListResponse(result)
      return {
        ...parsed,
      }
    },
    async upload(key: string, body: Blob | Uint8Array | string, uploadOptions: { contentType?: string } = {}): Promise<void> {
      await blob.put(key, body, {
        access,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: uploadOptions.contentType,
        ...auth(options),
      })
    },
  }
}

async function importVercelBlobPeer(): Promise<VercelBlobModule> {
  const testImport = (globalThis as { __vitehubWorkspaceImportVercelBlobPeer?: () => Promise<unknown> }).__vitehubWorkspaceImportVercelBlobPeer
  return testImport ? await testImport() as VercelBlobModule : bundledVercelBlob as VercelBlobModule
}

class VercelBlobWorkspaceStore implements WorkspaceStore {
  #baseline: WorkspaceSnapshot | undefined
  #options: VercelBlobWorkspaceStoreOptions
  #files: ReturnType<typeof createVercelBlobClient> | undefined

  #root: string
  #legacyRoot: string

  constructor(options: VercelBlobWorkspaceStoreOptions, workspaceName: string) {
    this.#options = resolveRuntimeVercelBlobWorkspaceStore(options, typeof process !== "undefined" ? process.env : {})
    this.#root = joinBlobPath(ownedBlobPrefix("workspaces", this.#options.prefix, "Workspace"), workspaceName)
    const legacyPrefix = this.#options.prefix ?? ".vitehub/workspaces"
    this.#legacyRoot = joinBlobPath(legacyPrefix, workspaceName)
  }

  #fileKey(path: string, options: { allowEmpty?: boolean } = {}) {
    return joinBlobPath(this.#root, "files", normalizeSafeWorkspacePath(path, { allowEmpty: options.allowEmpty }))
  }

  #legacyFileKey(path: string, options: { allowEmpty?: boolean } = {}) {
    return joinBlobPath(this.#legacyRoot, "files", normalizeSafeWorkspacePath(path, { allowEmpty: options.allowEmpty }))
  }

  async #client() {
    this.#files ||= createVercelBlobClient(this.#options)
    return await this.#files
  }

  #metaKey(key: string) {
    return joinBlobPath(this.#root, ".vitehub/meta", normalizeSafeWorkspacePath(key.endsWith(".json") ? key : `${key}.json`))
  }

  #snapshotKey(id: string) {
    return joinBlobPath(this.#root, ".vitehub/snapshots", `${id}.json`)
  }

  #legacyMetaKey(key: string) {
    return joinBlobPath(this.#legacyRoot, ".vitehub/meta", normalizeSafeWorkspacePath(key.endsWith(".json") ? key : `${key}.json`))
  }

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    const normalized = normalizeSafeWorkspacePath(path)
    const pathname = this.#fileKey(normalized)
    let file = await (await this.#client()).download(pathname).catch((error: unknown) => {
      if (isNotFoundError(error)) return undefined
      throw error
    })
    if (!file && this.#legacyRoot !== this.#root) file = await (await this.#client()).download(this.#legacyFileKey(normalized)).catch((error: unknown) => {
      if (isNotFoundError(error)) return undefined
      throw error
    })
    if (!file) return undefined
    const bytes = await file.arrayBuffer()
    return { path: normalized, content: new Uint8Array(bytes) }
  }

  async writeFile(path: string, file: WorkspaceFile): Promise<void> {
    const normalized = normalizeSafeWorkspacePath(path)
    await (await this.#client()).upload(this.#fileKey(normalized), new Blob([contentToBytes(file.content) as any]), {
      contentType: contentType(normalized, file.mediaType),
    })
  }

  async list(prefix = "", options: ListOptions = {}): Promise<WorkspaceEntry[]> {
    const normalizedPrefix = normalizeSafeWorkspacePath(prefix, { allowEmpty: true })
    const filePrefix = this.#fileKey(normalizedPrefix, { allowEmpty: true })
    const currentBase = `${this.#fileKey("", { allowEmpty: true })}/`
    const legacyBase = `${this.#legacyFileKey("", { allowEmpty: true })}/`
    const files = await this.#listBlobs(normalizedPrefix ? `${filePrefix}/` : currentBase)
    const legacyFiles = this.#legacyRoot === this.#root ? [] : await this.#listBlobs(normalizedPrefix ? `${this.#legacyFileKey(normalizedPrefix, { allowEmpty: true })}/` : legacyBase)
    const entries = new Map<string, WorkspaceEntry>()

    // Process legacy entries first so entries under the current root always win
    // when both roots contain the same workspace path during migration.
    for (const blob of [...legacyFiles, ...files]) {
      const base = blob.key.startsWith(legacyBase) ? legacyBase : currentBase
      const path = normalizeWorkspacePath(blob.key.slice(base.length))
      if (!path) continue
      if (isExcludedWorkspacePath(path, options.exclude)) continue
      if (normalizedPrefix && !path.startsWith(`${normalizedPrefix}/`)) continue
      const relative = normalizedPrefix ? path.slice(normalizedPrefix.length + 1) : path
      if (!options.recursive && relative.includes("/")) {
        const child = relative.split("/")[0]!
        const directory = normalizedPrefix ? `${normalizedPrefix}/${child}` : child
        entries.set(directory, { path: directory, type: "directory" })
        continue
      }

      entries.set(path, {
        mtime: blob.lastModified,
        path,
        size: blob.size,
        type: "file",
      })

      if (options.recursive) {
        const parts = path.split("/")
        for (let index = 1; index < parts.length; index++) {
          const dir = parts.slice(0, index).join("/")
          if (isExcludedWorkspacePath(dir, options.exclude)) continue
          entries.set(dir, { path: dir, type: "directory" })
        }
      }
    }

    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  async glob(pattern: string | string[], options: GlobOptions = {}): Promise<WorkspaceEntry[]> {
    const patterns = Array.isArray(pattern) ? pattern.map(normalizeSafeWorkspacePattern) : normalizeSafeWorkspacePattern(pattern)
    const { cwd, matches } = createWorkspaceGlobMatcher(patterns, options)
    const entries = await this.list(cwd, { recursive: true })
    return entries.filter(entry => entry.type === "file" && matches(entry.path))
  }

  async stat(path: string): Promise<WorkspaceStat | undefined> {
    const normalized = normalizeSafeWorkspacePath(path)
    const file = await this.readFile(normalized)
    if (file) {
      const bytes = contentToBytes(file.content)
      return {
        digest: await sha256(bytes),
        path: normalized,
        size: bytes.byteLength,
        type: "file",
      }
    }
    const children = await this.list(normalized, { recursive: false })
    return children.length ? { path: normalized, type: "directory" } : undefined
  }

  async mkdir(path: string, _options: MkdirOptions = {}): Promise<void> {
    normalizeSafeWorkspacePath(path)
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    const normalized = normalizeSafeWorkspacePath(path)
    if (options.ifDigest !== undefined) {
      throw workspaceConflict(`[vitehub] Vercel Blob does not support atomic conditional removal for: ${path}.`)
    }
    const client = await this.#client()
    const targets: string[] = []
    const fileKeys = [this.#fileKey(normalized)]
    if (this.#legacyRoot !== this.#root) fileKeys.push(this.#legacyFileKey(normalized))
    for (const key of fileKeys) {
      if (await client.head(key)) targets.push(key)
    }
    if (options.recursive) {
      const prefixes = [`${this.#fileKey(normalized)}/`]
      if (this.#legacyRoot !== this.#root) prefixes.push(`${this.#legacyFileKey(normalized)}/`)
      for (const prefix of prefixes) {
        for (const blob of await this.#listBlobs(prefix)) {
          if (!targets.includes(blob.key)) targets.push(blob.key)
        }
      }
    }

    if (!targets.length) {
      if (options.force) return
      throw workspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
    }

    await Promise.all(targets.map(target => client.delete(target)))
  }

  async snapshot(options: SnapshotOptions = {}): Promise<WorkspaceSnapshot> {
    const snapshot = await createCurrentSnapshotFromStore(this, options.name)
    await (await this.#client()).upload(this.#snapshotKey(snapshot.id), JSON.stringify(snapshot), {
      contentType: "application/json; charset=utf-8",
    })
    this.#baseline = snapshot
    return snapshot
  }

  async diff(options: DiffOptions = {}): Promise<WorkspaceDiff> {
    const from = options.from || this.#baseline
    const to = await createCurrentSnapshotFromStore(this)
    return diffSnapshots(from, to)
  }

  async getMeta(key: string): Promise<unknown> {
    const file = await this.#readJson(this.#metaKey(key), this.#legacyMetaKey(key))
    return file
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await (await this.#client()).upload(this.#metaKey(key), JSON.stringify(value), {
      contentType: "application/json; charset=utf-8",
    })
  }

  async #listBlobs(prefix: string): Promise<BlobListItem[]> {
    const blobs: BlobListItem[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    let hasMore = true
    do {
      if (cursor && seenCursors.has(cursor)) {
        throw workspaceError("[vitehub] Vercel Blob pagination returned a repeated cursor.")
      }
      if (cursor) seenCursors.add(cursor)
      const result = await (await this.#client()).list({
        cursor,
        limit: 1000,
        prefix,
      }) as BlobListResult
      blobs.push(...result.items)
      cursor = result.cursor
      hasMore = result.hasMore ?? Boolean(cursor)
    } while (cursor && hasMore)
    return blobs
  }

  async #readJson(pathname: string, fallback?: string): Promise<unknown> {
    let file = await (await this.#client()).download(pathname).catch((error: unknown) => { if (isNotFoundError(error)) return undefined; throw error })
    if (!file && fallback) file = await (await this.#client()).download(fallback).catch((error: unknown) => { if (isNotFoundError(error)) return undefined; throw error })
    return file ? JSON.parse(await file.text()) : undefined
  }
}

export function createVercelBlobWorkspaceStore(options: VercelBlobWorkspaceStoreOptions, workspaceName: string): WorkspaceStore {
  return new VercelBlobWorkspaceStore(options, workspaceName)
}
