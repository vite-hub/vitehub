import { WorkspaceError } from "../errors.ts"
import { contentToBytes, matchesAny, normalizeSafeWorkspacePath, normalizeSafeWorkspacePattern, normalizeWorkspacePath, sha256 } from "../path.ts"
import { resolveRuntimeVercelBlobWorkspaceStore } from "../store-provider.ts"
import { createSnapshotFromEntries, diffSnapshots } from "./utils.ts"

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
} from "../types.ts"

type BlobListItem = {
  pathname: string
  size?: number
  uploadedAt?: Date | string
  url?: string
}

type BlobListResult = {
  blobs: BlobListItem[]
  cursor?: string
  hasMore?: boolean
}

function joinBlobPath(...parts: string[]) {
  return parts.map(part => normalizeWorkspacePath(part)).filter(Boolean).join("/")
}

function contentType(path: string, fallback?: string) {
  if (fallback) return fallback
  if (path.endsWith(".json")) return "application/json; charset=utf-8"
  if (path.endsWith(".md") || path.endsWith(".txt")) return "text/plain; charset=utf-8"
}

class VercelBlobWorkspaceStore implements WorkspaceStore {
  #baseline: WorkspaceSnapshot | undefined
  #options: VercelBlobWorkspaceStoreOptions

  constructor(options: VercelBlobWorkspaceStoreOptions, private workspaceName: string) {
    this.#options = resolveRuntimeVercelBlobWorkspaceStore(options, typeof process !== "undefined" ? process.env : {})
  }

  get #root() {
    return joinBlobPath(this.#options.prefix || ".vitehub/workspaces", this.workspaceName)
  }

  #fileKey(path: string, options: { allowEmpty?: boolean } = {}) {
    return joinBlobPath(this.#root, "files", normalizeSafeWorkspacePath(path, { allowEmpty: options.allowEmpty }))
  }

  #access() {
    return this.#options.access || "private"
  }

  #metaKey(key: string) {
    return joinBlobPath(this.#root, ".vitehub/meta", normalizeSafeWorkspacePath(key.endsWith(".json") ? key : `${key}.json`))
  }

  #snapshotKey(id: string) {
    return joinBlobPath(this.#root, ".vitehub/snapshots", `${id}.json`)
  }

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    const normalized = normalizeSafeWorkspacePath(path)
    const { get, head } = await import("@vercel/blob")
    const pathname = this.#fileKey(normalized)
    const current = await head(pathname, { token: this.#options.token }).catch(() => null) as BlobListItem | null
    if (!current?.url) return undefined
    const result = await get(current.url, {
      access: this.#access(),
      token: this.#options.token,
    })
    if (!result || result.statusCode !== 200) return undefined
    const bytes = await new Response(result.stream).arrayBuffer()
    return { path: normalized, content: new Uint8Array(bytes) }
  }

  async writeFile(path: string, file: WorkspaceFile): Promise<void> {
    const normalized = normalizeSafeWorkspacePath(path)
    const { put } = await import("@vercel/blob")
    await put(this.#fileKey(normalized), new Blob([contentToBytes(file.content) as any]), {
      access: this.#access(),
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: contentType(normalized, file.mediaType),
      token: this.#options.token,
    })
  }

  async list(prefix = "", options: ListOptions = {}): Promise<WorkspaceEntry[]> {
    const normalizedPrefix = normalizeSafeWorkspacePath(prefix, { allowEmpty: true })
    const filePrefix = this.#fileKey(normalizedPrefix, { allowEmpty: true })
    const files = await this.#listBlobs(normalizedPrefix ? `${filePrefix}/` : `${this.#fileKey("", { allowEmpty: true })}/`)
    const entries = new Map<string, WorkspaceEntry>()

    for (const blob of files) {
      const path = normalizeWorkspacePath(blob.pathname.slice(`${this.#fileKey("", { allowEmpty: true })}/`.length))
      if (!path) continue
      if (normalizedPrefix && !path.startsWith(`${normalizedPrefix}/`)) continue
      if (!options.recursive && normalizedPrefix && path.slice(normalizedPrefix.length + 1).includes("/")) continue
      if (!options.recursive && !normalizedPrefix && path.includes("/")) {
        entries.set(path.split("/")[0]!, { path: path.split("/")[0]!, type: "directory" })
        continue
      }

      const bytes = await this.#readBytes(path)
      entries.set(path, {
        digest: bytes ? await sha256(bytes) : undefined,
        mtime: blob.uploadedAt ? new Date(blob.uploadedAt).getTime() : undefined,
        path,
        size: blob.size,
        type: "file",
      })

      if (options.recursive) {
        const parts = path.split("/")
        for (let index = 1; index < parts.length; index++) {
          const dir = parts.slice(0, index).join("/")
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
    const { del, head } = await import("@vercel/blob")
    const targets: string[] = []
    const current = await head(this.#fileKey(normalized), { token: this.#options.token }).catch(() => null) as BlobListItem | null
    if (current?.url) targets.push(current.url)
    else if (options.recursive) {
      for (const blob of await this.#listBlobs(`${this.#fileKey(normalized)}/`)) {
        if (blob.url) targets.push(blob.url)
        else targets.push(blob.pathname)
      }
    }

    if (!targets.length) {
      if (options.force) return
      throw new WorkspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
    }

    await del(targets, { token: this.#options.token })
  }

  async snapshot(options: SnapshotOptions = {}): Promise<WorkspaceSnapshot> {
    const { put } = await import("@vercel/blob")
    const snapshot = await createSnapshotFromEntries(await this.list("", { recursive: true }), options.name)
    await put(this.#snapshotKey(snapshot.id), JSON.stringify(snapshot), {
      access: this.#access(),
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json; charset=utf-8",
      token: this.#options.token,
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
    const { put } = await import("@vercel/blob")
    await put(this.#metaKey(key), JSON.stringify(value), {
      access: this.#access(),
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json; charset=utf-8",
      token: this.#options.token,
    })
  }

  async #listBlobs(prefix: string): Promise<BlobListItem[]> {
    const { list } = await import("@vercel/blob")
    const blobs: BlobListItem[] = []
    let cursor: string | undefined
    do {
      const result = await list({
        cursor,
        limit: 1000,
        mode: "expanded",
        prefix,
        token: this.#options.token,
      }) as BlobListResult
      blobs.push(...result.blobs)
      cursor = result.hasMore ? result.cursor : undefined
    } while (cursor)
    return blobs
  }

  async #readBytes(path: string): Promise<Uint8Array | undefined> {
    const file = await this.readFile(path)
    return file ? contentToBytes(file.content) : undefined
  }

  async #readJson(pathname: string): Promise<unknown> {
    const { get, head } = await import("@vercel/blob")
    const current = await head(pathname, { token: this.#options.token }).catch(() => null) as BlobListItem | null
    if (!current?.url) return undefined
    const result = await get(current.url, { access: this.#access(), token: this.#options.token })
    if (!result || result.statusCode !== 200) return undefined
    return await new Response(result.stream).json()
  }
}

export function createVercelBlobWorkspaceStore(options: VercelBlobWorkspaceStoreOptions, workspaceName: string): WorkspaceStore {
  return new VercelBlobWorkspaceStore(options, workspaceName)
}
