import { workspaceError } from "../../core/errors.ts"
import { contentToBytes, isExcludedWorkspacePath, matchesAny, normalizeSafeWorkspacePath, normalizeSafeWorkspacePattern, normalizeWorkspacePath, sha256 } from "../../core/path.ts"
import { resolveRuntimeVercelBlobWorkspaceStore } from "../../storage/provider.ts"
import { createSnapshotFromEntries, diffSnapshots } from "../../storage/utils.ts"

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

type BlobListItem = {
  key: string
  size?: number
  lastModified?: number
  type?: string
}

type BlobListResult = {
  items: BlobListItem[]
  cursor?: string
}

type VercelBlobModule = {
  del(key: string, options?: { token?: string }): Promise<void>
  get(key: string, options: { access: "private" | "public", token?: string }): Promise<{
    blob: { contentType: string, size: number }
    statusCode: 200
    stream: ReadableStream<Uint8Array>
  } | { statusCode: 304, stream: null } | null>
  head(key: string, options?: { token?: string }): Promise<{ contentType?: string, pathname: string, size: number, uploadedAt: Date }>
  list(options: { cursor?: string, limit?: number, prefix: string, token?: string }): Promise<{
    blobs: Array<{ pathname: string, size?: number, uploadedAt?: Date }>
    cursor?: string
  }>
  put(key: string, body: Blob | Uint8Array | string, options: {
    access: "private" | "public"
    addRandomSuffix: boolean
    allowOverwrite: boolean
    contentType?: string
    token?: string
  }): Promise<unknown>
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

async function createVercelBlobClient(options: VercelBlobWorkspaceStoreOptions) {
  const blob = await importVercelBlobPeer()
  const access = options.access || "private"
  return {
    async delete(key: string): Promise<void> {
      await blob.del(key, auth(options))
    },
    async download(key: string): Promise<Blob> {
      const result = await blob.get(key, { access, ...auth(options) })
      if (!result || result.statusCode !== 200 || !result.stream) throw Object.assign(new Error("not found"), { code: "NotFound" })
      return await new Response(result.stream, {
        headers: result.blob.contentType ? { "content-type": result.blob.contentType } : undefined,
      }).blob()
    },
    async head(key: string): Promise<BlobListItem> {
      const result = await blob.head(key, auth(options))
      return {
        key: result.pathname,
        lastModified: result.uploadedAt.getTime(),
        size: result.size,
        type: result.contentType,
      }
    },
    async list(optionsInput: { cursor?: string, limit?: number, prefix: string }): Promise<BlobListResult> {
      const result = await blob.list({ ...optionsInput, ...auth(options) })
      return {
        cursor: result.cursor,
        items: result.blobs.map(item => ({
          key: item.pathname,
          lastModified: item.uploadedAt?.getTime(),
          size: item.size,
        })),
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

const vercelBlobPeerSpecifier = "@vercel/blob"

async function importVercelBlobPeer(): Promise<VercelBlobModule> {
  try {
    const testImport = (globalThis as { __vitehubWorkspaceImportVercelBlobPeer?: () => Promise<unknown> }).__vitehubWorkspaceImportVercelBlobPeer
    if (testImport) return await testImport() as VercelBlobModule
    return await import(vercelBlobPeerSpecifier) as VercelBlobModule
  }
  catch (error) {
    handleVercelBlobImportError(error)
  }
}

function handleVercelBlobImportError(error: unknown): never {
  if (isMissingVercelBlobError(error)) {
    throw workspaceError("[vitehub] @vercel/blob is required for the Vercel Blob Workspace Store. Package: @vercel/blob.", { cause: error })
  }
  throw error
}

function isMissingVercelBlobError(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false
  return error.message.includes("Cannot find package '@vercel/blob'")
    || error.message.includes("Cannot find module '@vercel/blob'")
}

class VercelBlobWorkspaceStore implements WorkspaceStore {
  #baseline: WorkspaceSnapshot | undefined
  #options: VercelBlobWorkspaceStoreOptions
  #files: ReturnType<typeof createVercelBlobClient> | undefined

  constructor(options: VercelBlobWorkspaceStoreOptions, private workspaceName: string) {
    this.#options = resolveRuntimeVercelBlobWorkspaceStore(options, typeof process !== "undefined" ? process.env : {})
  }

  get #root() {
    return joinBlobPath(this.#options.prefix || ".vitehub/workspaces", this.workspaceName)
  }

  #fileKey(path: string, options: { allowEmpty?: boolean } = {}) {
    return joinBlobPath(this.#root, "files", normalizeSafeWorkspacePath(path, { allowEmpty: options.allowEmpty }))
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

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    const normalized = normalizeSafeWorkspacePath(path)
    const pathname = this.#fileKey(normalized)
    const file = await (await this.#client()).download(pathname).catch(() => null)
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
    const files = await this.#listBlobs(normalizedPrefix ? `${filePrefix}/` : `${this.#fileKey("", { allowEmpty: true })}/`)
    const entries = new Map<string, WorkspaceEntry>()

    for (const blob of files) {
      const path = normalizeWorkspacePath(blob.key.slice(`${this.#fileKey("", { allowEmpty: true })}/`.length))
      if (!path) continue
      if (isExcludedWorkspacePath(path, options.exclude)) continue
      if (normalizedPrefix && !path.startsWith(`${normalizedPrefix}/`)) continue
      if (!options.recursive && normalizedPrefix && path.slice(normalizedPrefix.length + 1).includes("/")) continue
      if (!options.recursive && !normalizedPrefix && path.includes("/")) {
        entries.set(path.split("/")[0]!, { path: path.split("/")[0]!, type: "directory" })
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

  async glob(pattern: string | string[], _options: GlobOptions = {}): Promise<WorkspaceEntry[]> {
    const patterns = Array.isArray(pattern) ? pattern.map(normalizeSafeWorkspacePattern) : normalizeSafeWorkspacePattern(pattern)
    const entries = await this.list("", { recursive: true })
    return entries.filter(entry => entry.type === "file" && matchesAny(entry.path, patterns))
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
    const client = await this.#client()
    const targets: string[] = []
    const current = await client.head(this.#fileKey(normalized)).catch(() => null)
    if (current) targets.push(this.#fileKey(normalized))
    else if (options.recursive) {
      for (const blob of await this.#listBlobs(`${this.#fileKey(normalized)}/`)) {
        targets.push(blob.key)
      }
    }

    if (!targets.length) {
      if (options.force) return
      throw workspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
    }

    await Promise.all(targets.map(target => client.delete(target)))
  }

  async snapshot(options: SnapshotOptions = {}): Promise<WorkspaceSnapshot> {
    const snapshot = await createSnapshotFromEntries(await this.list("", { recursive: true }), options.name)
    await (await this.#client()).upload(this.#snapshotKey(snapshot.id), JSON.stringify(snapshot), {
      contentType: "application/json; charset=utf-8",
    })
    this.#baseline = snapshot
    return snapshot
  }

  async diff(options: DiffOptions = {}): Promise<WorkspaceDiff> {
    const from = options.from || this.#baseline
    const to = await createSnapshotFromEntries(await this.list("", { recursive: true }))
    return diffSnapshots(from, to)
  }

  async getMeta(key: string): Promise<unknown> {
    const file = await this.#readJson(this.#metaKey(key))
    return file
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await (await this.#client()).upload(this.#metaKey(key), JSON.stringify(value), {
      contentType: "application/json; charset=utf-8",
    })
  }

  async #listBlobs(prefix: string): Promise<BlobListItem[]> {
    const blobs: BlobListItem[] = []
    let cursor: string | undefined
    do {
      const result = await (await this.#client()).list({
        cursor,
        limit: 1000,
        prefix,
      }) as BlobListResult
      blobs.push(...result.items)
      cursor = result.cursor
    } while (cursor)
    return blobs
  }

  async #readJson(pathname: string): Promise<unknown> {
    const file = await (await this.#client()).download(pathname).catch(() => null)
    return file ? JSON.parse(await file.text()) : undefined
  }
}

export function createVercelBlobWorkspaceStore(options: VercelBlobWorkspaceStoreOptions, workspaceName: string): WorkspaceStore {
  return new VercelBlobWorkspaceStore(options, workspaceName)
}
