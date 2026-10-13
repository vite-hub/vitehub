import { and, desc, eq, lt, sql } from "drizzle-orm"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"
import { ViteHubError } from "@vite-hub/runtime"

import { workspaceConflict, workspaceError } from "../core/errors.ts"
import { copyJsonFileMetadata, copyJsonWorkspaceMetadata } from "../core/file-metadata.ts"
import { normalizeHistoryPath, validateHistoryMessage } from "../core/history.ts"
import { contentToBytes, decodeFile, isExcludedWorkspacePath, isWorkspaceBytes, normalizeSafeWorkspacePath, sha256 } from "../core/path.ts"
import { createMemoryWorkspaceStore, forkMemoryWorkspaceStore } from "./memory.ts"
import { workspaceStoreTarget } from "./target.ts"
import { createSnapshotFromEntries, diffSnapshots } from "./utils.ts"
import { workspaceHistorySchema, type HistoryManifestFile } from "./history-schema.ts"
import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"

import type { BlobStorage } from "@vite-hub/blob"
import type { RuntimeDrizzleDatabase } from "@vite-hub/database"
import type { DiffOptions, GlobOptions, ListOptions, MkdirOptions, RmOptions, SnapshotOptions, WorkspaceFile, WorkspaceHistoryListOptions, WorkspaceHistoryListResult, WorkspaceRevision, WorkspaceRevisionView, WorkspaceSnapshot, WorkspaceStore, WorkspaceStoreHistory } from "../core/types.ts"

const { workspaceHistoryRefs: refs, workspaceHistoryRevisions: revisions, workspaceHistoryObjects: objects, workspaceHistoryMetadata: metadata } = workspaceHistorySchema
type RevisionRow = typeof revisions.$inferSelect
type CommitOptions = Parameters<WorkspaceStoreHistory["commit"]>[0]

export interface BlobDatabaseWorkspaceStoreOptions {
  blob: BlobStorage
  database: RuntimeDrizzleDatabase<Record<string, unknown>>
  /** Stable workspace identity. Deleted identities cannot be reused. */
  workspace: string
  /** A dedicated Blob key prefix. Defaults to vitehub/workspace-history. */
  prefix?: string
}

export interface BlobDatabaseWorkspaceStore extends WorkspaceStore {
  history: WorkspaceStoreHistory
  /** Tombstone the identity and remove all file objects, including failed uploads. Safe to retry. */
  delete(): Promise<void>
}

function publicRevision(row: RevisionRow): WorkspaceRevision {
  const revision: WorkspaceRevision = {
    id: row.id,
    parentId: row.parentId,
    createdAt: row.createdAt,
    files: row.files,
    bytes: row.bytes,
  }
  if (row.message !== null) revision.message = row.message
  if (row.metadata !== null) revision.metadata = structuredClone(row.metadata)
  return revision
}

class ContentAddressedWorkspaceStore implements BlobDatabaseWorkspaceStore {
  #namespace: Promise<string>
  #ready?: Promise<void>
  #draft?: Promise<{ store: WorkspaceStore, head: WorkspaceRevision | null }>
  #dirty = false
  #baseline?: WorkspaceSnapshot
  #queue: Promise<void> = Promise.resolve()

  constructor(private options: BlobDatabaseWorkspaceStoreOptions) {
    if (!hasRuntimeType(options.workspace, "string") || !options.workspace) throw workspaceError("[vitehub] Blob + Database Store requires a workspace identity.")
    const prefix = options.prefix ?? "vitehub/workspace-history"
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) throw workspaceError("[vitehub] History Blob prefix must contain only letters, numbers, underscores, dashes, and single slashes.")
    this.#namespace = sha256(options.workspace).then(digest => `${prefix}/${digest}`)
  }

  [workspaceStoreTarget]() {
    return { provider: "blob-database", workspace: this.options.workspace }
  }

  history: WorkspaceStoreHistory = {
    head: async () => {
      const ref = await this.#ref()
      return ref.deleted || !ref.head ? null : publicRevision(await this.#revision(ref.head))
    },
    list: async options => await this.#listHistory(options),
    open: async id => await this.#open(id),
    usage: async () => {
      const workspace = await this.#key()
      const [result] = await this.options.database.values<[number, number]>(sql`
        select coalesce(sum(size), 0) as bytes, count(*) as objects from (
          select distinct json_extract(file.value, '$.digest') as digest,
            json_extract(file.value, '$.size') as size
          from ${revisions}, json_each(${revisions.entries}) as file
          where ${revisions.workspace} = ${workspace} and ${revisions.published} = 1
            and exists (select 1 from ${refs} where ${refs.workspace} = ${workspace} and ${refs.deleted} = 0)
        )
      `)
      return { bytes: result?.[0] ?? 0, objects: result?.[1] ?? 0 }
    },
    commit: async options => await this.#mutate(async () => {
      const revision = await this.#commit(options)
      this.#draft = undefined
      this.#dirty = false
      this.#baseline = undefined
      return revision
    }),
  }

  async #key() {
    const workspace = await this.#namespace
    this.#ready ??= this.options.database.insert(refs).values({ workspace }).onConflictDoNothing().then(() => {}, error => {
      this.#ready = undefined
      throw error
    })
    await this.#ready
    return workspace
  }

  async #ref() {
    const workspace = await this.#key()
    const [ref] = await this.options.database.select().from(refs).where(eq(refs.workspace, workspace))
    if (!ref) throw workspaceError("[vitehub] Workspace history ref is missing.")
    return ref
  }

  #deleted(): never {
    throw new ViteHubError("WORKSPACE_NOT_FOUND", "[vitehub] This Workspace has been deleted. Use a new workspace identity.", { details: { workspace: this.options.workspace } })
  }

  async #assertActive() {
    if ((await this.#ref()).deleted) this.#deleted()
  }

  async #revision(id: string): Promise<RevisionRow> {
    const workspace = await this.#key()
    const [row] = await this.options.database.select().from(revisions).where(and(
      eq(revisions.workspace, workspace), eq(revisions.id, id), eq(revisions.published, true),
      sql`exists (select 1 from ${refs} where ${refs.workspace} = ${workspace} and ${refs.deleted} = 0)`,
    ))
    if (!row) throw new ViteHubError("WORKSPACE_NOT_FOUND", `[vitehub] Workspace revision does not exist: ${id}.`)
    return row
  }

  async #listHistory(options: WorkspaceHistoryListOptions = {}) {
    const limit = options.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw workspaceErrorDiagnostics.WORKSPACE_R0070({ message: "[vitehub] History list limit must be an integer from 1 to 100." })
    const workspace = await this.#key()
    const cursor = options.cursor ? await this.#revision(options.cursor) : undefined
    const rows = await this.options.database.select().from(revisions).where(and(
      eq(revisions.workspace, workspace), eq(revisions.published, true),
      cursor ? lt(revisions.sequence, cursor.sequence) : undefined,
      sql`exists (select 1 from ${refs} where ${refs.workspace} = ${workspace} and ${refs.deleted} = 0)`,
    )).orderBy(desc(revisions.sequence)).limit(limit + 1)
    const result: WorkspaceHistoryListResult = { revisions: rows.slice(0, limit).map(publicRevision) }
    if (rows.length > limit) result.cursor = rows[limit - 1]!.id
    return result
  }

  async #open(id: string): Promise<WorkspaceRevisionView> {
    const row = await this.#revision(id)
    const workspace = await this.#key()
    // Only the manifest is needed for directory, size, digest, and MIME inspection.
    const entries = new Map<string, import("../core/types.ts").WorkspaceStat>()
    for (const [path, file] of Object.entries(row.entries)) {
      entries.set(path, { path, type: "file", digest: file.digest, size: file.size, mediaType: file.mediaType, metadata: structuredClone(file.metadata), revision: id })
      const parts = path.split("/")
      for (let index = 1; index < parts.length; index++) {
        const directory = parts.slice(0, index).join("/")
        entries.set(directory, { path: directory, type: "directory" })
      }
    }
    entries.set("", { path: "", type: "directory" })
    return Object.freeze({
      revision: publicRevision(row),
      list: async (path = "", options?: ListOptions) => {
        await this.#assertActive()
        const normalized = normalizeSafeWorkspacePath(path, { allowEmpty: true }).split("/").filter(Boolean).join("/")
        return [...entries.values()].filter(entry => entry.path && entry.path !== normalized
          && (!normalized || entry.path.startsWith(`${normalized}/`))
          && !isExcludedWorkspacePath(entry.path, options?.exclude)
          && (options?.recursive || !entry.path.slice(normalized ? normalized.length + 1 : 0).includes("/")))
          .sort((left, right) => left.path.localeCompare(right.path)).map(entry => structuredClone(entry))
      },
      stat: async (path: string) => {
        await this.#assertActive()
        const normalized = path === "" ? "" : normalizeHistoryPath(path)
        const entry = entries.get(normalized)
        if (!entry) throw workspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
        return structuredClone(entry)
      },
      readFile: async <TOptions extends import("../core/types.ts").ReadFileOptions | undefined = undefined>(path: string, options?: TOptions) => {
        await this.#assertActive()
        const normalized = normalizeHistoryPath(path)
        const file = Object.hasOwn(row.entries, normalized) ? row.entries[normalized] : undefined
        if (!file) throw workspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
        const [error, body] = await this.options.blob.get(`${workspace}/sha256/${file.digest}`)
        if (error) throw error
        if (!body) throw workspaceError(`[vitehub] Retained history object is missing: ${file.digest}.`)
        const bytes = new Uint8Array(await body.arrayBuffer())
        if (bytes.byteLength !== file.size || await sha256(bytes) !== file.digest) throw workspaceError(`[vitehub] Retained history object failed its content hash check: ${file.digest}.`)
        return decodeFile(bytes, options)
      },
    })
  }

  async #commit(options: CommitOptions): Promise<WorkspaceRevision> {
    validateHistoryMessage(options.message)
    const workspace = await this.#key()
    const ref = await this.#ref()
    if (ref.deleted) this.#deleted()
    if (ref.head !== options.ifHead) throw this.#conflict(options.ifHead, ref.head)
    const entries: Record<string, HistoryManifestFile> = Object.create(null)
    const contents = new Map<string, Uint8Array>()
    for (const [path, file] of Object.entries(options.files).sort(([left], [right]) => left.localeCompare(right))) {
      const normalized = normalizeHistoryPath(path)
      if (Object.hasOwn(entries, normalized)) throw workspaceError(`[vitehub] Duplicate history file path: ${normalized}.`)
      if (!hasRuntimeType(file.content, "string") && !isWorkspaceBytes(file.content)) throw workspaceError(`[vitehub] Invalid history file content: ${normalized}.`)
      const bytes = new Uint8Array(contentToBytes(file.content))
      const digest = await sha256(bytes)
      const entry: HistoryManifestFile = { digest, size: bytes.byteLength, mediaType: file.mediaType || "application/octet-stream" }
      if (file.metadata !== undefined) entry.metadata = copyJsonFileMetadata(normalized, file.metadata)
      entries[normalized] = entry
      contents.set(digest, bytes)
    }
    for (const path of Object.keys(entries)) {
      const parts = path.split("/")
      for (let index = 1; index < parts.length; index++) {
        if (Object.hasOwn(entries, parts.slice(0, index).join("/"))) throw workspaceError(`[vitehub] History path is both a file and a directory: ${path}.`)
      }
    }
    const manifest = {
      parentId: options.ifHead,
      createdAt: new Date().toISOString(),
      message: options.message ?? null,
      metadata: copyJsonWorkspaceMetadata("history revision", options.metadata) ?? null,
      entries,
    }
    const id = await sha256(manifest)
    const registry = [...contents].map(([digest, bytes]) => ({ digest, size: bytes.byteLength }))
    await this.options.database.insert(objects).select(sql`
      select ${refs.workspace}, json_extract(object.value, '$.digest'), json_extract(object.value, '$.size')
      from ${refs}, json_each(${JSON.stringify(registry)}) as object
      where ${refs.workspace} = ${workspace} and ${refs.deleted} = 0
    `).onConflictDoNothing()
    await this.#assertActive()
    const upload = async ([digest, bytes]: [string, Uint8Array]) => {
      const key = `${workspace}/sha256/${digest}`
      const [headError, object] = await this.options.blob.head(key)
      if (headError && headError.code !== "BLOB_NOT_FOUND") throw headError
      if (!object) {
        const [uploadError] = await this.options.blob.put(key, bytes, { addRandomSuffix: false, contentType: "application/octet-stream" })
        if (uploadError) {
          // Another committer may have uploaded the same immutable bytes first.
          const [concurrentError, concurrentObject] = await this.options.blob.head(key)
          if (concurrentError || !concurrentObject) throw uploadError
        }
      }
      if ((await this.#ref()).deleted) {
        await this.#removeObject(key)
        this.#deleted()
      }
    }
    const uploads = [...contents]
    for (let offset = 0; offset < uploads.length; offset += 8) {
      const results = await Promise.allSettled(uploads.slice(offset, offset + 8).map(upload))
      for (const result of results) if (result.status === "rejected") throw result.reason
    }
    const row = { ...manifest, entries: { ...entries }, workspace, id, sequence: ref.sequence + 1, files: Object.keys(entries).length, bytes: Object.values(entries).reduce((total, entry) => total + entry.size, 0) }
    // All supported Database drivers execute batch atomically. No interactive transaction is needed.
    const [, changed] = await this.options.database.batch([
      this.options.database.insert(revisions).select(sql`
        select ${row.workspace}, ${row.id}, ${row.parentId}, ${row.sequence}, ${row.createdAt},
          ${row.message}, ${row.metadata === null ? null : JSON.stringify(row.metadata)},
          ${row.files}, ${row.bytes}, ${JSON.stringify(row.entries)}, 0
        from ${refs} where ${refs.workspace} = ${workspace} and ${refs.deleted} = 0
      `).onConflictDoNothing(),
      this.options.database.update(refs).set({ head: id, sequence: sql`${refs.sequence} + 1` }).where(and(eq(refs.workspace, workspace), eq(refs.deleted, false), sql`${refs.head} is ${options.ifHead}`)).returning({ head: refs.head }),
      this.options.database.update(revisions).set({ published: true }).where(and(eq(revisions.workspace, workspace), eq(revisions.id, id), sql`exists (select 1 from ${refs} where ${refs.workspace} = ${workspace} and ${refs.head} = ${id} and ${refs.deleted} = 0)`)),
    ])
    if (!changed.length) {
      const actual = await this.#ref()
      if (actual.deleted) this.#deleted()
      throw this.#conflict(options.ifHead, actual.head)
    }
    return publicRevision({ ...row, published: true })
  }

  #conflict(expected: string | null, actual: string | null) {
    return workspaceConflict("[vitehub] Workspace head changed before the history commit.", { details: { expected, actual, workspace: this.options.workspace } })
  }

  async #removeObject(key: string) {
    const [headError, object] = await this.options.blob.head(key)
    if (headError?.code === "BLOB_NOT_FOUND") return
    if (headError) throw headError
    if (!object) return
    const [error] = await this.options.blob.del(key)
    if (error && error.code !== "BLOB_NOT_FOUND") throw error
  }

  async delete(): Promise<void> {
    await this.#mutate(() => this.#delete())
  }

  async #delete(): Promise<void> {
    const workspace = await this.#key()
    await this.options.database.update(refs).set({ deleted: true, head: null }).where(eq(refs.workspace, workspace))
    // The tombstone fences publishers before cleanup. Keep it after cleanup so late writers cannot resurrect this namespace.
    const catalog = await this.options.database.select().from(objects).where(eq(objects.workspace, workspace))
    for (const object of catalog) {
      await this.#removeObject(`${workspace}/sha256/${object.digest}`)
    }
    // Listing also finds late uploads after an interrupted deletion. Retry delete() after stopping abandoned requests.
    let cursor: string | undefined
    const cursors = new Set<string>()
    const remaining: string[] = []
    do {
      const [error, page] = await this.options.blob.list({ prefix: `${workspace}/sha256/`, cursor, limit: 1000 })
      if (error) throw error
      remaining.push(...page.blobs.map(object => object.pathname))
      cursor = page.hasMore ? page.cursor : undefined
      if (page.hasMore && (!cursor || cursors.has(cursor))) throw workspaceError("[vitehub] History cleanup received an invalid Blob cursor.")
      if (cursor) cursors.add(cursor)
    } while (cursor)
    for (let offset = 0; offset < remaining.length; offset += 1000) {
      const [error] = await this.options.blob.del(remaining.slice(offset, offset + 1000))
      if (error) throw error
    }
    await this.options.database.batch([
      this.options.database.delete(revisions).where(eq(revisions.workspace, workspace)),
      this.options.database.delete(objects).where(eq(objects.workspace, workspace)),
      this.options.database.delete(metadata).where(eq(metadata.workspace, workspace)),
    ])
    this.#draft = undefined
    this.#dirty = false
  }

  async #loadDraft() {
    await this.#assertActive()
    const head = await this.history.head()
    if (this.#draft && !this.#dirty && (await this.#draft).head?.id !== head?.id) this.#draft = undefined
    this.#draft ??= (async () => {
      const store = createMemoryWorkspaceStore()
      if (head) {
        const view = await this.history.open(head.id)
        for (const entry of await view.list("", { recursive: true })) {
          if (entry.type === "file") await store.writeFile(entry.path, { path: entry.path, content: await view.readFile(entry.path, { encoding: "binary" }), mediaType: entry.mediaType, metadata: entry.metadata })
        }
      }
      await store.snapshot()
      return { store, head }
    })().catch(error => { this.#draft = undefined; throw error })
    return await this.#draft
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#queue.then(operation)
    this.#queue = pending.then(() => {}, () => {})
    return pending
  }

  async #write(operation: (store: WorkspaceStore) => Promise<void>) {
    await this.#mutate(async () => {
      const draft = await this.#loadDraft()
      const candidate = forkMemoryWorkspaceStore(draft.store)
      const dirty = this.#dirty
      this.#dirty = true
      try {
        await operation(candidate)
        await this.#assertActive()
        this.#draft = Promise.resolve({ store: candidate, head: draft.head })
      }
      catch (error) {
        this.#dirty = dirty
        throw error
      }
    })
  }

  async readFile(path: string) { return await (await this.#loadDraft()).store.readFile(normalizeSafeWorkspacePath(path, { allowEmpty: true })) }
  async list(path = "", options?: ListOptions) { return await (await this.#loadDraft()).store.list(path, options) }
  async glob(pattern: string | string[], options?: GlobOptions) { return await (await this.#loadDraft()).store.glob(pattern, options) }
  async stat(path: string) { return await (await this.#loadDraft()).store.stat(normalizeSafeWorkspacePath(path, { allowEmpty: true })) }
  async writeFile(path: string, file: WorkspaceFile) { await this.#write(store => store.writeFile(normalizeHistoryPath(path), file)) }
  async writeFileConditional(path: string, file: WorkspaceFile, ifDigest: string | null) { await this.#write(store => store.writeFileConditional!(normalizeHistoryPath(path), file, ifDigest)) }
  async mkdir(path: string, options?: MkdirOptions) { await this.#write(store => store.mkdir(normalizeHistoryPath(path), options)) }
  async rm(path: string, options?: RmOptions) { await this.#write(store => store.rm(normalizeHistoryPath(path), options)) }
  async removeEmptyDirectory(path: string) { await this.#write(store => store.removeEmptyDirectory!(normalizeHistoryPath(path))) }

  async snapshot(options: SnapshotOptions = {}): Promise<WorkspaceSnapshot> {
    return await this.#mutate(async () => {
      const draft = await this.#loadDraft()
      const files: Record<string, WorkspaceFile> = Object.create(null)
      for (const entry of await draft.store.list("", { recursive: true })) {
        if (entry.type === "file") files[entry.path] = (await draft.store.readFile(entry.path))!
      }
      const revision = await this.#commit({ ifHead: draft.head?.id ?? null, files, message: options.name })
      this.#dirty = false
      this.#draft = undefined
      this.#baseline = undefined
      const view = await this.#open(revision.id)
      const snapshot = await createSnapshotFromEntries(await view.list("", { recursive: true }), options.name)
      this.#baseline = { ...snapshot, id: revision.id, createdAt: revision.createdAt }
      return this.#baseline
    })
  }

  async diff(options: DiffOptions = {}) {
    const draft = await this.#loadDraft()
    const baseline = options.from ?? this.#baseline ?? (draft.head ? { ...await createSnapshotFromEntries(await (await this.#open(draft.head.id)).list("", { recursive: true })), id: draft.head.id } : undefined)
    return diffSnapshots(baseline, await createSnapshotFromEntries(await draft.store.list("", { recursive: true })))
  }

  async getMeta(key: string) {
    const workspace = await this.#key()
    const [row] = await this.options.database.select().from(metadata).where(and(
      eq(metadata.workspace, workspace), eq(metadata.key, key),
      sql`exists (select 1 from ${refs} where ${refs.workspace} = ${workspace} and ${refs.deleted} = 0)`,
    ))
    return row?.value
  }

  async setMeta(key: string, value: unknown) {
    await this.#assertActive()
    const workspace = await this.#key()
    if (value === undefined) {
      await this.options.database.delete(metadata).where(and(eq(metadata.workspace, workspace), eq(metadata.key, key)))
      return
    }
    await this.options.database.insert(metadata).select(this.options.database.select({
      workspace: sql<string>`${workspace}`.as("workspace"), key: sql<string>`${key}`.as("key"), value: sql<unknown>`${JSON.stringify(value)}`.as("value"),
    }).from(refs).where(and(eq(refs.workspace, workspace), eq(refs.deleted, false)))).onConflictDoUpdate({ target: [metadata.workspace, metadata.key], set: { value: sql`${JSON.stringify(value)}` } })
  }
}

/** Blob stores bytes; Database atomically publishes immutable folder manifests. */
export function createBlobDatabaseWorkspaceStore(options: BlobDatabaseWorkspaceStoreOptions): BlobDatabaseWorkspaceStore {
  return new ContentAddressedWorkspaceStore(options)
}
