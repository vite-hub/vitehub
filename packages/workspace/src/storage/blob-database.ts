import { is } from "drizzle-orm"
import { PgAsyncDatabase } from "drizzle-orm/pg-core/async/db"
import { ViteHubError } from "@vite-hub/runtime"
import { vitehubOwnedPrefix } from "@vite-hub/internal/owned-paths"

import { workspaceConflict, workspaceError } from "../core/errors.ts"
import { copyJsonFileMetadata, copyJsonWorkspaceMetadata } from "../core/file-metadata.ts"
import { defaultWorkspaceHistoryRef, historyConflict, normalizeHistoryPath, normalizeHistoryRef, readHistoryDeleteRef, rejectHistoryHead, validateHistoryMessage } from "../core/history.ts"
import { contentToBytes, decodeFile, isExcludedWorkspacePath, isWorkspaceBytes, normalizeSafeWorkspacePath, sha256 } from "../core/path.ts"
import { createMemoryWorkspaceStore, forkMemoryWorkspaceStore } from "./memory.ts"
import { provideWorkspaceStoreTarget } from "./target.ts"
import { createSnapshotFromEntries, diffSnapshots } from "./utils.ts"
import { blobDatabaseSources } from "./blob-database-sources.ts"
import { postgresHistoryIndex } from "./history-index-postgres.ts"
import { sqliteHistoryIndex } from "./history-index-sqlite.ts"
import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"

import type { BlobStorage } from "@vite-hub/blob"
import type { HistoryManifestFile } from "./history-schema.ts"
import type { HistoryIndex, HistoryRevisionRow } from "./history-index.ts"
import type { PostgresHistoryDatabase } from "./history-index-postgres.ts"
import type { SqliteHistoryDatabase } from "./history-index-sqlite.ts"
import type { BlobDatabaseSources } from "./blob-database-sources.ts"
import type { DiffOptions, GlobOptions, ListOptions, MkdirOptions, RmOptions, SnapshotOptions, WorkspaceFile, WorkspaceHistoryDeleteRefOptions, WorkspaceHistoryListOptions, WorkspaceHistoryListResult, WorkspaceHistoryRef, WorkspaceRevision, WorkspaceRevisionView, WorkspaceSnapshot, WorkspaceStore, WorkspaceStoreHistory, WorkspaceStoreHistoryCommitOptions } from "../core/types.ts"

type HistoryDatabase = SqliteHistoryDatabase | PostgresHistoryDatabase

export interface BlobDatabaseWorkspaceStoreOptions {
  /**
   * The Blob store name, such as `"default"`, or a Blob store. With a name, ViteHub can report whether every instance
   * reads the same files.
   */
  blob: string | BlobStorage
  /**
   * The Database name, such as `"history"`, or its Drizzle database, or a function that returns it. The Store opens the
   * Database on first use. SQLite, libSQL, D1, and Postgres work. Add `workspaceHistorySchema` from
   * `@vite-hub/workspace/blob-database` (SQLite) or `@vite-hub/workspace/blob-database/postgres` to the Database.
   */
  database: string | HistoryDatabase | (() => HistoryDatabase)
  /** Stable workspace identity. Deleted identities cannot be reused. */
  workspace: string
  /**
   * A dedicated namespace under `_vitehub/workspace-history/`. For example, `handbook`
   * stores objects under `_vitehub/workspace-history/handbook/`.
   */
  prefix?: string
}

/**
 * Where a Blob + Database Store keeps history. `database` lets owners that keep their own tables next to the history,
 * such as Content edit sessions, use the same Database without a second setting.
 */
export type BlobDatabaseWorkspaceStoreTarget =
  | { provider: "blob-database", workspace: string, dialect: "sqlite", database: SqliteHistoryDatabase }
  | { provider: "blob-database", workspace: string, dialect: "postgresql", database: PostgresHistoryDatabase }

interface Backend {
  blob: BlobStorage
  index: HistoryIndex
  target: BlobDatabaseWorkspaceStoreTarget
}

export interface BlobDatabaseWorkspaceStore extends WorkspaceStore {
  history: WorkspaceStoreHistory
  /** Tombstone the identity and remove all file objects, including failed uploads. Safe to retry. */
  delete(): Promise<void>
}

function publicRevision(row: HistoryRevisionRow): WorkspaceRevision {
  const revision: WorkspaceRevision = {
    id: row.id,
    ref: row.ref,
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
  #namespace: Promise<string[]>
  #ready?: Promise<string>
  // The working tree follows the default ref and lives only in this instance.
  #draft?: Promise<{ store: WorkspaceStore, head: WorkspaceRevision | null }>
  #dirty = false
  #baseline?: WorkspaceSnapshot
  #queue: Promise<void> = Promise.resolve()
  #backend?: Promise<Backend>

  constructor(private options: BlobDatabaseWorkspaceStoreOptions) {
    if (typeof options.workspace !== "string" || !options.workspace) throw workspaceError("[vitehub] Blob + Database Store requires a workspace identity.")
    if (options.prefix !== undefined && !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(options.prefix)) throw workspaceError("[vitehub] History Blob prefix must contain only letters, numbers, underscores, dashes, and single slashes.")
    // ViteHub owns every history object, so a custom prefix only nests below the owned root.
    const root = `${vitehubOwnedPrefix}workspace-history`
    const prefix = options.prefix === undefined ? root : `${root}/${options.prefix}`
    // Prefer the owned namespace, but keep reading the namespace used before
    // this change when its database identity already exists.
    const legacyPrefix = options.prefix === undefined ? "vitehub/workspace-history" : options.prefix
    this.#namespace = sha256(options.workspace).then(digest => {
      const current = `${prefix}/${digest}`
      const legacy = `${legacyPrefix}/${digest}`
      return legacy === current ? [current] : [current, legacy]
    })
    provideWorkspaceStoreTarget(this, () => this.#storeTarget())
  }

  async #storeTarget(): Promise<BlobDatabaseWorkspaceStoreTarget> {
    return (await this.#backendReady()).target
  }

  [blobDatabaseSources](): BlobDatabaseSources {
    const { blob, database } = this.options
    return { blob: typeof blob === "string" ? blob : undefined, database: typeof database === "string" ? database : undefined }
  }

  #backendReady(): Promise<Backend> {
    this.#backend ??= this.#connect().catch((error: unknown) => {
      this.#backend = undefined
      throw error
    })
    return this.#backend
  }

  async #connect(): Promise<Backend> {
    const { blob, database, workspace } = this.options
    const storage = typeof blob === "string" ? await useBlobStore(blob) : blob
    const db: unknown = typeof database === "string"
      ? (await useNamedDatabase())(database).db
      : typeof database === "function" ? database() : database
    if (is(db, PgAsyncDatabase)) {
      return { blob: storage, index: postgresHistoryIndex(db), target: { provider: "blob-database", workspace, dialect: "postgresql", database: db } }
    }
    if (isSqliteDatabase(db)) {
      return { blob: storage, index: sqliteHistoryIndex(db), target: { provider: "blob-database", workspace, dialect: "sqlite", database: db } }
    }
    throw workspaceErrorDiagnostics.WORKSPACE_R0077({ message: `[vitehub] The \`database\` of the Blob + Database Store for workspace "${workspace}" is not a Drizzle database.` })
  }

  async #index() {
    return (await this.#backendReady()).index
  }

  async #blob() {
    return (await this.#backendReady()).blob
  }

  history: WorkspaceStoreHistory = {
    head: async options => await this.#head(normalizeHistoryRef(options?.ref)),
    list: async options => await this.#listHistory(options),
    refs: async () => await this.#refs(),
    open: async id => await this.#open(id),
    usage: async () => await (await this.#index()).usage(await this.#key()),
    commit: async options => await this.#mutate(async () => {
      const revision = await this.#commit(options)
      if (revision.ref === defaultWorkspaceHistoryRef) {
        this.#draft = undefined
        this.#dirty = false
        this.#baseline = undefined
      }
      return revision
    }),
    deleteRef: async options => await this.#mutate(async () => await this.#deleteRef(readHistoryDeleteRef(options))),
  }

  async #key() {
    this.#ready ??= Promise.all([this.#namespace, this.#index()])
      .then(([candidates, index]) => index.claim(candidates[0]!, candidates[1]))
      .catch((error: unknown) => {
        this.#ready = undefined
        throw error
      })
    return await this.#ready
  }

  async #isDeleted() {
    const workspace = await this.#key()
    const deleted = await (await this.#index()).deleted(workspace)
    if (deleted === undefined) throw workspaceError("[vitehub] Workspace history identity is missing.")
    return deleted
  }

  async #ref(workspace: string, ref: string) {
    return await (await this.#index()).ref(workspace, ref)
  }

  async #head(ref: string) {
    const workspace = await this.#key()
    const row = await this.#ref(workspace, ref)
    return row?.head ? publicRevision(await this.#revision(row.head)) : null
  }

  async #refs(): Promise<WorkspaceHistoryRef[]> {
    const workspace = await this.#key()
    const heads = await (await this.#index()).heads(workspace)
    return heads.map(({ ref, revision }) => ({ name: ref, head: publicRevision(revision) })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  }

  #deleted(): never {
    throw new ViteHubError("WORKSPACE_NOT_FOUND", "[vitehub] This Workspace has been deleted. Use a new workspace identity.", { details: { workspace: this.options.workspace } })
  }

  async #assertActive() {
    if (await this.#isDeleted()) this.#deleted()
  }

  async #revision(id: string): Promise<HistoryRevisionRow> {
    const workspace = await this.#key()
    const row = await (await this.#index()).revision(workspace, id)
    if (!row) throw new ViteHubError("WORKSPACE_NOT_FOUND", `[vitehub] Workspace revision does not exist: ${id}.`)
    return row
  }

  async #listHistory(options: WorkspaceHistoryListOptions = {}) {
    const limit = options.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw workspaceErrorDiagnostics.WORKSPACE_R0070({ message: "[vitehub] History list limit must be an integer from 1 to 100." })
    const ref = normalizeHistoryRef(options.ref)
    const path = options.path === undefined ? undefined : normalizeHistoryPath(options.path)
    const workspace = await this.#key()
    const cursor = options.cursor ? await this.#revision(options.cursor) : undefined
    if (cursor && cursor.ref !== ref) throw workspaceErrorDiagnostics.WORKSPACE_R0070({ message: `[vitehub] History cursor belongs to ref "${cursor.ref}". Pass it with the ref that returned it.` })
    const rows = await (await this.#index()).list(workspace, { ref, before: cursor?.sequence, path, limit: limit + 1 })
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
        const key = await (await this.#index()).objectKey(workspace, file.digest)
        if (!key) throw workspaceError(`[vitehub] Retained history object is missing: ${file.digest}.`)
        const [error, body] = await (await this.#blob()).get(`${workspace}/sha256/${key}`)
        if (error) throw error
        if (!body) throw workspaceError(`[vitehub] Retained history object is missing: ${file.digest}.`)
        const bytes = new Uint8Array(await body.arrayBuffer())
        if (bytes.byteLength !== file.size || await sha256(bytes) !== file.digest) throw workspaceError(`[vitehub] Retained history object failed its content hash check: ${file.digest}.`)
        return decodeFile(bytes, options)
      },
    })
  }

  async #commit(options: WorkspaceStoreHistoryCommitOptions): Promise<WorkspaceRevision> {
    validateHistoryMessage(options.message)
    const ref = normalizeHistoryRef(options.ref)
    if ((options.files === undefined) === (options.changes === undefined)) throw workspaceError("[vitehub] History commit requires exactly one of files or changes.")
    const expectedHeads = Object.entries(options.ifHeads ?? {}).map(([name, head]) => {
      if (head !== null && (typeof head !== "string" || !head)) throw workspaceError("[vitehub] History ifHeads values must be revision ids or null.")
      return [normalizeHistoryRef(name), head] as const
    })
    const workspace = await this.#key()
    const index = await this.#index()
    const blob = await this.#blob()
    await this.#assertActive()
    const current = await this.#ref(workspace, ref)
    if ((current?.head ?? null) !== options.ifHead) rejectHistoryHead(options, this.#conflict(ref, options.ifHead, current?.head ?? null))
    // A change commit starts from the head manifest. Unchanged objects are already registered and uploaded.
    const entries: Record<string, HistoryManifestFile> = Object.create(null)
    const removed = new Set<string>()
    if (options.changes && current?.head) Object.assign(entries, (await this.#revision(current.head)).entries)
    for (const path of options.changes?.delete ?? []) {
      const normalized = normalizeHistoryPath(path)
      if (!Object.hasOwn(entries, normalized)) throw workspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
      delete entries[normalized]
      removed.add(normalized)
    }
    const puts = new Set<string>()
    const contents = new Map<string, Uint8Array>()
    for (const [path, file] of Object.entries(options.files ?? options.changes?.put ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      const normalized = normalizeHistoryPath(path)
      if (puts.has(normalized) || removed.has(normalized)) throw workspaceError(`[vitehub] Duplicate history file path: ${normalized}.`)
      puts.add(normalized)
      if (typeof file.content !== "string" && !isWorkspaceBytes(file.content)) throw workspaceError(`[vitehub] Invalid history file content: ${normalized}.`)
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
    const sorted: Record<string, HistoryManifestFile> = Object.create(null)
    for (const path of Object.keys(entries).sort((left, right) => left.localeCompare(right))) sorted[path] = entries[path]!
    const manifest = {
      ref,
      parentId: options.ifHead,
      createdAt: new Date().toISOString(),
      message: options.message ?? null,
      metadata: copyJsonWorkspaceMetadata("history revision", options.metadata) ?? null,
      entries: sorted,
    }
    const id = await sha256(manifest)
    const register = async () => {
      await index.register(workspace, [...contents].map(([digest, bytes]) => ({ digest, key: `${digest}-${crypto.randomUUID()}`, size: bytes.byteLength })))
      await this.#assertActive()
      return await index.objectKeys(workspace, [...contents.keys()])
    }
    const upload = async ([digest, generation]: [string, string]) => {
      const key = `${workspace}/sha256/${generation}`
      const [headError, object] = await blob.head(key)
      if (headError && headError.code !== "BLOB_NOT_FOUND") throw headError
      if (!object) {
        const [uploadError] = await blob.put(key, contents.get(digest)!, { addRandomSuffix: false, contentType: "application/octet-stream" })
        if (!await index.hasObject(workspace, generation) || await this.#isDeleted()) {
          await this.#removeObject(key)
          await this.#assertActive()
          return
        }
        if (uploadError) {
          // Another committer may have uploaded the same immutable bytes first.
          const [concurrentError, concurrentObject] = await blob.head(key)
          if (concurrentError || !concurrentObject) throw uploadError
        }
      }
    }
    const uploadAll = async (uploads: [string, string][]) => {
      for (let offset = 0; offset < uploads.length; offset += 8) {
        const results = await Promise.allSettled(uploads.slice(offset, offset + 8).map(upload))
        for (const result of results) if (result.status === "rejected") throw result.reason
      }
    }
    const row = { ...manifest, entries: { ...sorted }, workspace, id, sequence: (current?.sequence ?? 0) + 1, files: Object.keys(sorted).length, bytes: Object.values(sorted).reduce((total, entry) => total + entry.size, 0) }
    for (let attempt = 0; ; attempt++) {
      const uploads = await register()
      await uploadAll(uploads)
      const published = await index.publish(workspace, {
        revision: { ...row, committed: false },
        ifHead: options.ifHead,
        ifHeads: expectedHeads,
        keys: uploads.map(([, key]) => key),
        complete: uploads.length === contents.size,
      })
      if (published) break
      if (await this.#isDeleted()) this.#deleted()
      for (const [name, expected] of expectedHeads) {
        const actual = (await this.#ref(workspace, name))?.head ?? null
        if (actual !== expected) throw this.#conflict(name, expected, actual)
      }
      const actual = (await this.#ref(workspace, ref))?.head ?? null
      if (actual !== options.ifHead) rejectHistoryHead(options, this.#conflict(ref, options.ifHead, actual))
      if (attempt === 4) throw workspaceConflict("[vitehub] History objects of this commit are being deleted by history.deleteRef(). Retry the commit.", { details: { workspace: this.options.workspace, ref } })
      await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt))
    }
    return publicRevision({ ...row, committed: true })
  }

  async #deleteRef({ ref, ifHead }: WorkspaceHistoryDeleteRefOptions): Promise<boolean> {
    const workspace = await this.#key()
    await this.#assertActive()
    const current = await this.#ref(workspace, ref)
    const head = current?.head ?? null
    if (ifHead !== undefined && head !== ifHead) throw this.#conflict(ref, ifHead, head)
    if (!current) {
      await this.#removeUnusedObjects(workspace)
      return false
    }
    const removed = await (await this.#index()).deleteRef(workspace, ref, head)
    if (!removed) throw this.#conflict(ref, head, (await this.#ref(workspace, ref))?.head ?? null)
    await this.#removeUnusedObjects(workspace)
    return true
  }

  async #removeUnusedObjects(workspace: string) {
    const index = await this.#index()
    const marked = await index.markedObjects(workspace)
    for (let offset = 0; offset < marked.length; offset += 8) {
      const batch = marked.slice(offset, offset + 8)
      await Promise.all(batch.map(key => this.#removeObject(`${workspace}/sha256/${key}`)))
      await index.dropMarkedObjects(workspace, batch)
    }
  }

  #conflict(ref: string, expected: string | null, actual: string | null) {
    return historyConflict(ref, expected, actual, { workspace: this.options.workspace })
  }

  async #removeObject(key: string) {
    const blob = await this.#blob()
    const [headError, object] = await blob.head(key)
    if (headError?.code === "BLOB_NOT_FOUND") return
    if (headError) throw headError
    if (!object) return
    const [error] = await blob.delete(key)
    if (error && error.code !== "BLOB_NOT_FOUND") throw error
  }

  async delete(): Promise<void> {
    await this.#mutate(() => this.#delete())
  }

  async #delete(): Promise<void> {
    const workspace = await this.#key()
    const index = await this.#index()
    const blob = await this.#blob()
    await index.tombstone(workspace)
    // The tombstone fences publishers before cleanup. Keep it after cleanup so late writers cannot resurrect this namespace.
    for (const key of await index.objects(workspace)) {
      await this.#removeObject(`${workspace}/sha256/${key}`)
    }
    // Listing also finds late uploads after an interrupted deletion. Retry delete() after stopping abandoned requests.
    let cursor: string | undefined
    const cursors = new Set<string>()
    const remaining: string[] = []
    do {
      const [error, page] = await blob.list({ prefix: `${workspace}/sha256/`, cursor, limit: 1000 })
      if (error) throw error
      remaining.push(...page.blobs.map(object => object.pathname))
      cursor = page.hasMore ? page.cursor : undefined
      if (page.hasMore && (!cursor || cursors.has(cursor))) throw workspaceError("[vitehub] History cleanup received an invalid Blob cursor.")
      if (cursor) cursors.add(cursor)
    } while (cursor)
    for (let offset = 0; offset < remaining.length; offset += 1000) {
      const [error] = await blob.delete(remaining.slice(offset, offset + 1000))
      if (error) throw error
    }
    await index.purge(workspace)
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
      const revision = await this.#commit({ ifHead: draft.head?.id ?? null, files, message: options.name, ...(options.author ? { metadata: { author: options.author } } : {}) })
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
    return await (await this.#index()).getMeta(await this.#key(), key)
  }

  async setMeta(key: string, value: unknown) {
    await this.#assertActive()
    const workspace = await this.#key()
    const index = await this.#index()
    if (value === undefined) await index.deleteMeta(workspace, key)
    else await index.setMeta(workspace, key, value)
  }
}

function isSqliteDatabase(value: unknown): value is SqliteHistoryDatabase {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "batch") === "function"
}

async function useNamedDatabase(): Promise<(name: string) => { db: unknown }> {
  const { useDatabase } = await import("@vite-hub/database/runtime/registry")
  // SAFETY: The runtime accepts any configured name and throws DATABASE_NOT_FOUND for an unknown one. The generated registry types narrow the name.
  return useDatabase as (name: string) => { db: unknown }
}

async function useBlobStore(name: string): Promise<BlobStorage> {
  const { blob } = await import("@vite-hub/blob")
  return name === "default" ? blob : blob.store(name)
}

/** Blob stores bytes. The Database publishes immutable folder manifests and rejects a commit from a stale head. */
export function createBlobDatabaseWorkspaceStore(options: BlobDatabaseWorkspaceStoreOptions): BlobDatabaseWorkspaceStore {
  return new ContentAddressedWorkspaceStore(options)
}
