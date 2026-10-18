import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"
import { ViteHubError } from "@vite-hub/runtime"
import { vitehubOwnedPrefix } from "@vite-hub/internal/owned-paths"

import { workspaceError } from "../core/errors.ts"
import { copyJsonFileMetadata, copyJsonWorkspaceMetadata } from "../core/file-metadata.ts"
import { defaultWorkspaceHistoryRef, historyConflict, normalizeHistoryPath, normalizeHistoryRef, validateHistoryMessage } from "../core/history.ts"
import { contentToBytes, decodeFile, isExcludedWorkspacePath, isWorkspaceBytes, normalizeSafeWorkspacePath, sha256 } from "../core/path.ts"
import { createMemoryWorkspaceStore, forkMemoryWorkspaceStore } from "./memory.ts"
import { workspaceStoreTarget } from "./target.ts"
import { createSnapshotFromEntries, diffSnapshots } from "./utils.ts"
import { workspaceHistorySchema, type HistoryManifestFile } from "./history-schema.ts"
import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"

import type { BlobStorage } from "@vite-hub/blob"
import type { RuntimeDrizzleDatabase } from "@vite-hub/database"
import type { DiffOptions, GlobOptions, ListOptions, MkdirOptions, RmOptions, SnapshotOptions, WorkspaceFile, WorkspaceHistoryListOptions, WorkspaceHistoryListResult, WorkspaceHistoryRef, WorkspaceRevision, WorkspaceRevisionView, WorkspaceSnapshot, WorkspaceStore, WorkspaceStoreHistory, WorkspaceStoreHistoryCommitOptions } from "../core/types.ts"

const { workspaceHistoryWorkspaces: workspaces, workspaceHistoryRefs: refs, workspaceHistoryRevisions: revisions, workspaceHistoryObjects: objects, workspaceHistoryMetadata: metadata } = workspaceHistorySchema
type RevisionRow = typeof revisions.$inferSelect

export interface BlobDatabaseWorkspaceStoreOptions {
  blob: BlobStorage
  database: RuntimeDrizzleDatabase<Record<string, unknown>>
  /** Stable workspace identity. Deleted identities cannot be reused. */
  workspace: string
  /**
   * A dedicated namespace under `_vitehub/workspace-history/`. For example, `handbook`
   * stores objects under `_vitehub/workspace-history/handbook/`.
   */
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

  constructor(private options: BlobDatabaseWorkspaceStoreOptions) {
    if (!hasRuntimeType(options.workspace, "string") || !options.workspace) throw workspaceError("[vitehub] Blob + Database Store requires a workspace identity.")
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
  }

  [workspaceStoreTarget]() {
    return { provider: "blob-database", workspace: this.options.workspace }
  }

  history: WorkspaceStoreHistory = {
    head: async options => await this.#head(normalizeHistoryRef(options?.ref)),
    list: async options => await this.#listHistory(options),
    refs: async () => await this.#refs(),
    open: async id => await this.#open(id),
    usage: async () => {
      const workspace = await this.#key()
      const [result] = await this.options.database.values<[number, number]>(sql`
        select coalesce(sum(size), 0) as bytes, count(*) as objects from (
          select distinct json_extract(file.value, '$.digest') as digest,
            json_extract(file.value, '$.size') as size
          from ${revisions}, json_each(${revisions.entries}) as file
          where ${revisions.workspace} = ${workspace} and ${revisions.committed} = 1
            and ${this.#active(workspace)}
        )
      `)
      return { bytes: result?.[0] ?? 0, objects: result?.[1] ?? 0 }
    },
    commit: async options => await this.#mutate(async () => {
      const revision = await this.#commit(options)
      if (revision.ref === defaultWorkspaceHistoryRef) {
        this.#draft = undefined
        this.#dirty = false
        this.#baseline = undefined
      }
      return revision
    }),
  }

  async #key() {
    const candidates = await this.#namespace
    this.#ready ??= this.options.database.batch([
      // Read existing identities before claiming the new one. This preserves
      // legacy history when an installation upgrades, while the insert below
      // atomically claims the owned identity for new workspaces.
      this.options.database.select({ workspace: workspaces.workspace }).from(workspaces).where(eq(workspaces.workspace, candidates[0]!)),
      this.options.database.select({ workspace: workspaces.workspace }).from(workspaces).where(eq(workspaces.workspace, candidates[1] ?? candidates[0]!)),
      // Claim the owned identity only when no legacy identity exists. Keeping
      // this condition in the atomic batch avoids leaving an empty current row
      // that would shadow legacy history on the next process restart.
      this.options.database.insert(workspaces).select(sql`
        select ${candidates[0]!}, 0
        where not exists (
          select 1 from ${workspaces} where ${workspaces.workspace} = ${candidates[1] ?? candidates[0]!}
        )
      `).onConflictDoNothing(),
    ]).then((results: [Array<{ workspace: string }>, Array<{ workspace: string }>, unknown]) => {
      const [current, legacy] = results
      return current[0]?.workspace ?? legacy[0]?.workspace ?? candidates[0]!
    }).catch((error: unknown) => {
      this.#ready = undefined
      throw error
    })
    return await this.#ready
  }

  #active(workspace: string) {
    return sql`exists (select 1 from ${workspaces} where ${workspaces.workspace} = ${workspace} and ${workspaces.deleted} = 0)`
  }

  async #isDeleted() {
    const workspace = await this.#key()
    const [row] = await this.options.database.select({ deleted: workspaces.deleted }).from(workspaces).where(eq(workspaces.workspace, workspace))
    if (!row) throw workspaceError("[vitehub] Workspace history identity is missing.")
    return row.deleted
  }

  async #ref(workspace: string, ref: string) {
    const [row] = await this.options.database.select().from(refs).where(and(eq(refs.workspace, workspace), eq(refs.ref, ref), this.#active(workspace)))
    return row
  }

  async #head(ref: string) {
    const workspace = await this.#key()
    const row = await this.#ref(workspace, ref)
    return row?.head ? publicRevision(await this.#revision(row.head)) : null
  }

  async #refs(): Promise<WorkspaceHistoryRef[]> {
    const workspace = await this.#key()
    const heads = await this.options.database.select({ ref: refs.ref, head: refs.head }).from(refs)
      .where(and(eq(refs.workspace, workspace), isNotNull(refs.head), this.#active(workspace)))
    if (!heads.length) return []
    const rows = await this.options.database.select().from(revisions).where(and(
      eq(revisions.workspace, workspace), eq(revisions.committed, true), inArray(revisions.id, heads.map(row => row.head!)), this.#active(workspace),
    ))
    const byId = new Map(rows.map(row => [row.id, row]))
    return heads.flatMap(({ ref, head }) => {
      const row = byId.get(head!)
      return row ? [{ name: ref, head: publicRevision(row) }] : []
    }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  }

  #deleted(): never {
    throw new ViteHubError("WORKSPACE_NOT_FOUND", "[vitehub] This Workspace has been deleted. Use a new workspace identity.", { details: { workspace: this.options.workspace } })
  }

  async #assertActive() {
    if (await this.#isDeleted()) this.#deleted()
  }

  async #revision(id: string): Promise<RevisionRow> {
    const workspace = await this.#key()
    const [row] = await this.options.database.select().from(revisions).where(and(
      eq(revisions.workspace, workspace), eq(revisions.id, id), eq(revisions.committed, true), this.#active(workspace),
    ))
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
    const previousEntries = sql`
      coalesce((
        select previous.entries
        from ${revisions} as previous
        where previous.workspace = ${revisions.workspace}
          and previous.id = ${revisions.parentId}
          and previous.committed = 1
      ), '{}')
    `
    // Compare manifests with substr, not LIKE, so `%` and `_` in paths stay literal.
    const pathFilter = path === undefined ? undefined : sql`(
      exists (
        select 1
        from json_each(${revisions.entries}) as current_file
        left join json_each(${previousEntries}) as previous_file
          on previous_file.key = current_file.key
        where (current_file.key = ${path} or substr(current_file.key, 1, length(${path}) + 1) = ${path} || '/')
          and (
            previous_file.key is null
            or json_extract(current_file.value, '$.digest') is not json_extract(previous_file.value, '$.digest')
            or json_extract(current_file.value, '$.size') is not json_extract(previous_file.value, '$.size')
            or json_extract(current_file.value, '$.mediaType') is not json_extract(previous_file.value, '$.mediaType')
            or json_extract(current_file.value, '$.metadata') is not json_extract(previous_file.value, '$.metadata')
          )
      )
      or exists (
        select 1
        from json_each(${previousEntries}) as previous_file
        left join json_each(${revisions.entries}) as current_file
          on current_file.key = previous_file.key
        where (previous_file.key = ${path} or substr(previous_file.key, 1, length(${path}) + 1) = ${path} || '/')
          and current_file.key is null
      )
    )`
    const rows = await this.options.database.select().from(revisions).where(and(
      eq(revisions.workspace, workspace), eq(revisions.ref, ref), eq(revisions.committed, true),
      cursor ? lt(revisions.sequence, cursor.sequence) : undefined,
      pathFilter,
      this.#active(workspace),
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

  async #commit(options: WorkspaceStoreHistoryCommitOptions): Promise<WorkspaceRevision> {
    validateHistoryMessage(options.message)
    const ref = normalizeHistoryRef(options.ref)
    if ((options.files === undefined) === (options.changes === undefined)) throw workspaceError("[vitehub] History commit requires exactly one of files or changes.")
    const workspace = await this.#key()
    await this.#assertActive()
    const current = await this.#ref(workspace, ref)
    if ((current?.head ?? null) !== options.ifHead) throw this.#conflict(ref, options.ifHead, current?.head ?? null)
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
    const registry = [...contents].map(([digest, bytes]) => ({ digest, size: bytes.byteLength }))
    await this.options.database.insert(objects).select(sql`
      select ${workspaces.workspace}, json_extract(object.value, '$.digest'), json_extract(object.value, '$.size')
      from ${workspaces}, json_each(${JSON.stringify(registry)}) as object
      where ${workspaces.workspace} = ${workspace} and ${workspaces.deleted} = 0
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
      if (await this.#isDeleted()) {
        await this.#removeObject(key)
        this.#deleted()
      }
    }
    const uploads = [...contents]
    for (let offset = 0; offset < uploads.length; offset += 8) {
      const results = await Promise.allSettled(uploads.slice(offset, offset + 8).map(upload))
      for (const result of results) if (result.status === "rejected") throw result.reason
    }
    const row = { ...manifest, entries: { ...sorted }, workspace, id, sequence: (current?.sequence ?? 0) + 1, files: Object.keys(sorted).length, bytes: Object.values(sorted).reduce((total, entry) => total + entry.size, 0) }
    // All supported Database drivers execute batch atomically. No interactive transaction is needed.
    const [, , changed] = await this.options.database.batch([
      this.options.database.insert(refs).select(sql`
        select ${workspaces.workspace}, ${ref}, null, 0
        from ${workspaces} where ${workspaces.workspace} = ${workspace} and ${workspaces.deleted} = 0
      `).onConflictDoNothing(),
      this.options.database.insert(revisions).select(sql`
        select ${row.workspace}, ${row.id}, ${row.ref}, ${row.parentId}, ${row.sequence}, ${row.createdAt},
          ${row.message}, ${row.metadata === null ? null : JSON.stringify(row.metadata)},
          ${row.files}, ${row.bytes}, ${JSON.stringify(row.entries)}, 0
        from ${workspaces} where ${workspaces.workspace} = ${workspace} and ${workspaces.deleted} = 0
      `).onConflictDoNothing(),
      this.options.database.update(refs).set({ head: id, sequence: sql`${refs.sequence} + 1` }).where(and(eq(refs.workspace, workspace), eq(refs.ref, ref), sql`${refs.head} is ${options.ifHead}`, this.#active(workspace))).returning({ head: refs.head }),
      this.options.database.update(revisions).set({ committed: true }).where(and(eq(revisions.workspace, workspace), eq(revisions.id, id), sql`exists (select 1 from ${refs} where ${refs.workspace} = ${workspace} and ${refs.ref} = ${ref} and ${refs.head} = ${id})`, this.#active(workspace))),
    ])
    if (!changed.length) {
      if (await this.#isDeleted()) this.#deleted()
      throw this.#conflict(ref, options.ifHead, (await this.#ref(workspace, ref))?.head ?? null)
    }
    return publicRevision({ ...row, committed: true })
  }

  #conflict(ref: string, expected: string | null, actual: string | null) {
    return historyConflict(ref, expected, actual, { workspace: this.options.workspace })
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
    await this.options.database.batch([
      this.options.database.update(workspaces).set({ deleted: true }).where(eq(workspaces.workspace, workspace)),
      this.options.database.delete(refs).where(eq(refs.workspace, workspace)),
    ])
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
      this.#active(workspace),
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
    }).from(workspaces).where(and(eq(workspaces.workspace, workspace), eq(workspaces.deleted, false)))).onConflictDoUpdate({ target: [metadata.workspace, metadata.key], set: { value: sql`${JSON.stringify(value)}` } })
  }
}

/** Blob stores bytes; Database atomically publishes immutable folder manifests. */
export function createBlobDatabaseWorkspaceStore(options: BlobDatabaseWorkspaceStoreOptions): BlobDatabaseWorkspaceStore {
  return new ContentAddressedWorkspaceStore(options)
}
