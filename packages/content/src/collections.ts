import { array, defineCollection } from "@vite-hub/source"
import { ViteHubError } from "@vite-hub/runtime"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"
import { isWorkspaceConflict, registerWorkspacePlugin, useWorkspace } from "@vite-hub/workspace"

import {
  comarkJsonSchema,
  compileDocumentsPath,
  contentInvalid,
  fieldsJsonSchema,
  normalizeFrontmatter,
  parseDocumentFile,
  renderDocumentFile,
  validateFields,
  warnUntypedFields,
} from "./documents.ts"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubErrorDetails } from "@vite-hub/runtime"
import type { ArrayCollectionQuery, Collection, CollectionFacets } from "@vite-hub/source"
import type { WorkspaceRetainedHistory, WorkspaceRevision, WorkspaceRevisionView, WorkspaceWriteInput } from "@vite-hub/workspace"
import type { JsonSchema, Source as ComarkContentSource } from "comark-content"
import type { CompiledDocumentsPath, ContentFieldIssue, ContentFields, ContentFieldsInput, ContentFieldsOutput, DocumentsDefinition } from "./documents.ts"

/** The history refs Content owns: every save commits to `draft`; `publish()` copies documents to `published`. */
export type ContentRef = "draft" | "published"

const contentRefs: ReadonlySet<string> = new Set<ContentRef>(["draft", "published"])
const maxCommitAttempts = 8
const maxRevisionScan = 1_000
const maxUpdatedAtScan = 5_000
const listDefaultLimit = 50
const listMaxLimit = 1_000

/** One document read from a Content collection. */
export interface ContentDocument<TData = Record<string, unknown>> {
  collection: string
  /** Path below the collection folder without the extension, such as `hello` or `2026/hello`. */
  id: string
  /** Workspace path of the Markdown file, such as `posts/hello.md`. */
  path: string
  /** Validated frontmatter. */
  data: TData
  /** Markdown body after the frontmatter. */
  body: string
  /** SHA-256 of the file bytes. Pass it as `ifDigest` to save only over this version. */
  digest: string
  /** History revision the document was read from. */
  revision: string
  /**
   * When the document last changed on the ref it was read from: the `createdAt` of the newest revision on that ref
   * that added or changed its file. Null when the change is older than the 5,000 revisions Content scans.
   */
  updatedAt: string | null
}

/** A listed document. `list()` leaves out the body; read it with `get()`. */
export type ContentDocumentSummary<TData = Record<string, unknown>> = Omit<ContentDocument<TData>, "body">

/** One stored file as written, without parsing or validation. `raw()` returns it even when the frontmatter no longer validates. */
export interface ContentRawDocument {
  collection: string
  id: string
  /** Workspace path of the Markdown file, such as `posts/hello.md`. */
  path: string
  /** The file text, frontmatter included. */
  text: string
  /** SHA-256 of the file bytes, the same digest `get()`, `status()`, and `ifDigest` use. */
  digest: string
  /** History revision the file was read from. */
  revision: string
}

export interface ContentReadOptions {
  /** `published` (default) or `draft`. */
  ref?: ContentRef
  /** Read from one history revision instead of a ref head, for example one returned by `revisions()`. */
  revision?: string
  signal?: AbortSignal
}

type FilterValue = string | number | boolean | Date
type FieldName<TData> = Extract<keyof TData, string> | "id"

export interface ContentListOptions<TData = Record<string, unknown>> {
  /** `published` (default) or `draft`. */
  ref?: ContentRef
  /**
   * Match field values case-insensitively. An array matches any of its values; array fields match when any element
   * matches. Dates match their ISO string. `empty` lists fields that must have no value.
   */
  filter?: { [K in FieldName<TData>]?: FilterValue | readonly FilterValue[] } & { empty?: ReadonlyArray<FieldName<TData>> }
  /** Case-insensitive substring over the collection's `search` fields. */
  search?: string
  sort?: { field: FieldName<TData>, direction?: "asc" | "desc" }
  /** Fields to count into `page.facets`. */
  facets?: ReadonlyArray<FieldName<TData>>
  /** Page size, default 50, at most 1000. */
  limit?: number
  /** `nextCursor` from the previous page. A cursor from another revision or query is rejected as stale. */
  cursor?: string
  signal?: AbortSignal
}

export interface ContentPage<TData = Record<string, unknown>> {
  items: ContentDocumentSummary<TData>[]
  nextCursor: string | null
  /** Matching documents across every page. */
  total: number
  facets?: CollectionFacets
}

export interface ContentSaveInput<TInput = Record<string, unknown>> {
  /** Frontmatter field values. They are validated, stored as YAML, and must survive a JSON round trip. */
  data: TInput
  /** Markdown body. Defaults to an empty body. */
  body?: string
}

export interface ContentWriteOptions {
  /**
   * Expected digest of the document on the `draft` ref. `null` requires that it does not exist yet. A different
   * digest throws `WORKSPACE_CONFLICT`. Omit it to overwrite whatever the draft holds.
   */
  ifDigest?: string | null
  /** Revision message. Defaults to a generated one such as `Save posts/hello`. */
  message?: string
  /** JSON-safe revision metadata, such as the author. The `content` key is reserved. */
  metadata?: Record<string, unknown>
}

/**
 * - `draft`: saved but never published.
 * - `published`: the draft and the published version match.
 * - `changed`: published, with unpublished draft changes.
 * - `deleted`: removed from the draft, still published until the next publish.
 */
export type ContentDocumentState = "draft" | "published" | "changed" | "deleted"

export interface ContentDocumentStatus {
  collection: string
  id: string
  state: ContentDocumentState
  /** Digest on the `draft` ref, or null when the draft has no such document. Pass it to `publish({ expect })`. */
  draft: string | null
  /** Digest on the `published` ref, or null when it is not published. */
  published: string | null
}

/** One document `publish({ expect })` must find on the draft before it publishes it. */
export interface ContentPublishExpectation {
  /** Collection name. An unknown name throws `CONTENT_R0008`. */
  collection: string
  id: string
  /** The draft digest that was reviewed, from `status()` or `get({ ref: 'draft' })`. `null` expects the document deleted on the draft. */
  digest: string | null
}

export interface ContentPublishOptions<TCollection extends string = string> {
  /** Publish one collection. Omit to publish every collection. Cannot be combined with `expect`. */
  collection?: TCollection
  /** Publish only these documents of `collection`. Requires `collection`. Cannot be combined with `expect`. */
  ids?: readonly string[]
  /**
   * Publish exactly these documents, and only if each draft digest still matches. A draft saved after review throws
   * `WORKSPACE_CONFLICT` instead of being published. Confirm and approve flows must publish this way.
   */
  expect?: readonly ContentPublishExpectation[]
  /** Expected `published` head revision id, or null before the first publish. A different head throws `WORKSPACE_CONFLICT`. */
  ifHead?: string | null
  message?: string
  /** JSON-safe revision metadata, such as the author. The `content` key is reserved. */
  metadata?: Record<string, unknown>
}

/** A document whose draft no longer matches `publish({ expect })`. */
export interface ContentPublishMismatch {
  collection: string
  id: string
  /** The digest the caller expected. */
  expected: string | null
  /** The current draft digest, or null when the draft has no such document. */
  actual: string | null
}

export interface ContentPublishedDocument {
  collection: string
  id: string
  change: "add" | "update" | "delete"
}

export interface ContentPublishResult {
  /** The new `published` revision, or null when nothing differed from the draft. */
  revision: WorkspaceRevision | null
  documents: ContentPublishedDocument[]
}

export interface ContentRevisionsOptions {
  /** `draft` (default) for saves, or `published` for publishes. */
  ref?: ContentRef
  /** Revisions to return, default 20, at most 100. */
  limit?: number
  /** `cursor` from the previous call. */
  cursor?: string
}

export interface ContentRevisionsResult {
  revisions: WorkspaceRevision[]
  /** Pass to the next call to continue. Absent when the history is exhausted. */
  cursor?: string
}

/** An editable collection of Markdown documents. It is also a read-only Collection over the `published` ref. */
export interface ContentCollection<TFields extends ContentFields = ContentFields>
  extends Collection<ContentDocumentSummary<ContentFieldsOutput<TFields>>, ArrayCollectionQuery<string>> {
  readonly name: string
  /** The collection glob, such as `posts/**\/*.md`. */
  readonly path: string
  /** Frontmatter field names, in definition order. */
  readonly fields: readonly string[]
  /** JSON Schema of the frontmatter, built from each field's Standard JSON Schema. Forms and tools read it. */
  readonly schema: Record<string, unknown>
  /** List documents with filters, search, sort, facets, and a total. Reads `published` unless `ref` says otherwise. */
  list(options?: ContentListOptions<ContentFieldsOutput<TFields>>): Promise<ContentPage<ContentFieldsOutput<TFields>>>
  /** Read one document, or null when it does not exist. Throws `CONTENT_INVALID` when its frontmatter no longer validates. */
  get(id: string, options?: ContentReadOptions): Promise<ContentDocument<ContentFieldsOutput<TFields>> | null>
  /** Read one stored file without parsing or validating it, or null when it does not exist. Use it to show and diff any version. */
  raw(id: string, options?: ContentReadOptions): Promise<ContentRawDocument | null>
  /** Validate and commit a document to the `draft` ref. */
  save(id: string, input: ContentSaveInput<ContentFieldsInput<TFields>>, options?: ContentWriteOptions): Promise<ContentDocument<ContentFieldsOutput<TFields>>>
  /** Delete a document from the `draft` ref. It stays published until the next publish. */
  remove(id: string, options?: ContentWriteOptions): Promise<void>
  /** Save the version of a document from an earlier revision as the new draft. */
  restore(id: string, revision: string, options?: ContentWriteOptions): Promise<ContentDocument<ContentFieldsOutput<TFields>>>
  /** Compare one document on `draft` and `published`. Null when it exists on neither. */
  status(id: string): Promise<ContentDocumentStatus | null>
  /** Compare every document on `draft` and `published`, sorted by id. */
  status(): Promise<ContentDocumentStatus[]>
}

// Caches

/** Least-recently-used map bounded by total weight. */
class BoundedCache<TValue> {
  #entries = new Map<string, { value: TValue, weight: number }>()
  #weight = 0
  constructor(private readonly maxWeight: number, private readonly weigh: (value: TValue) => number = () => 1) {}

  get(key: string): TValue | undefined {
    const entry = this.#entries.get(key)
    if (!entry) return
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: TValue): void {
    const previous = this.#entries.get(key)
    if (previous) {
      this.#weight -= previous.weight
      this.#entries.delete(key)
    }
    const weight = this.weigh(value)
    if (weight > this.maxWeight) return
    this.#entries.set(key, { value, weight })
    this.#weight += weight
    for (const [oldest, entry] of this.#entries) {
      if (this.#weight <= this.maxWeight) break
      this.#entries.delete(oldest)
      this.#weight -= entry.weight
    }
  }

  delete(key: string): void {
    const entry = this.#entries.get(key)
    if (!entry) return
    this.#weight -= entry.weight
    this.#entries.delete(key)
  }
}

/** Run a promise-returning lookup once per key while it is in flight and cache successes. */
function memoize<TValue>(cache: BoundedCache<Promise<TValue>>, key: string, load: () => Promise<TValue>): Promise<TValue> {
  const cached = cache.get(key)
  if (cached) return cached
  const promise = load()
  cache.set(key, promise)
  promise.catch(() => cache.delete(key))
  return promise
}

async function sha256(text: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

async function mapLimit<TItem, TResult>(items: readonly TItem[], limit: number, run: (item: TItem) => Promise<TResult>): Promise<TResult[]> {
  const results: TResult[] = Array.from({ length: items.length })
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index]!)
    }
  }))
  return results
}

interface OpenedRevision {
  revision: WorkspaceRevision
  view: WorkspaceRevisionView
  /** Every file path in the revision with its SHA-256 digest. */
  files: ReadonlyMap<string, string>
}

interface RefState {
  revision: WorkspaceRevision | null
  opened?: OpenedRevision
}

type ParsedText =
  | { data: Record<string, unknown>, body: string, issues?: undefined }
  | { data?: undefined, body?: undefined, issues: ContentFieldIssue[] }

type IndexedDocument = ContentDocument<Record<string, unknown>>

interface CollectionEntry {
  path: string
  digest: string
}

// Shared runtime

/** A Comark Source over one ref of a collection. `loadedRevision` is the head its last enumeration read. */
export type ContentHistorySource = ComarkContentSource & { readonly loadedRevision?: string | null }

export interface ContentCollectionsOptions {
  workspace: string
  collections: Record<string, DocumentsDefinition>
}

export interface ContentCollectionsRuntime {
  readonly collections: ReadonlyMap<string, ContentCollection>
  collection(name: string): ContentCollection
  publish(options?: ContentPublishOptions): Promise<ContentPublishResult>
  revisions(collection: string, id: string, options?: ContentRevisionsOptions): Promise<ContentRevisionsResult>
  /** A Comark Source over the `published` ref of one collection. `withRef("draft")` pins the draft. */
  comarkSource(name: string): ContentHistorySource
  /** Called after `publish()` changes the `published` ref, with the affected collection names. */
  onPublish(listener: (collections: string[]) => Promise<void> | void): void
  /** The current `published` head revision id, or null before the first publish. */
  publishedHead(): Promise<string | null>
  /** Remove the Workspace validation plugin. */
  dispose(): void
}

function contentConflict(message: string, details: ViteHubErrorDetails): ViteHubError {
  return new ViteHubError("WORKSPACE_CONFLICT", message, { details })
}

function contentNotFound(collection: string, id: string): ViteHubError {
  return new ViteHubError("CONTENT_NOT_FOUND", `[vitehub] Content document ${JSON.stringify(`${collection}/${id}`)} does not exist.`, {
    details: { collection, id },
  })
}

function conflictRef(error: unknown): unknown {
  const details: unknown = Reflect.get(Object(error), "details")
  return details !== null && Object(details) === details ? Reflect.get(Object(details), "ref") : undefined
}

function assertRef(ref: unknown, fallback: ContentRef): ContentRef {
  if (ref === undefined) return fallback
  if (String(ref) !== ref || !contentRefs.has(ref)) {
    throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Content ref must be "draft" or "published", received ${JSON.stringify(ref)}.` })
  }
  // SAFETY: Membership in contentRefs proves the literal.
  return ref as ContentRef
}

function revisionTouches(revision: WorkspaceRevision, collection: string, id: string): boolean {
  const content: unknown = revision.metadata?.content
  const documents: unknown = content !== null && Object(content) === content ? Reflect.get(Object(content), "documents") : undefined
  return Array.isArray(documents) && documents.some(document =>
    document !== null && Object(document) === document
    && Reflect.get(document, "collection") === collection && Reflect.get(document, "id") === id)
}

function writeMetadata(metadata: Record<string, unknown> | undefined, content: Record<string, unknown>): Record<string, unknown> {
  if (metadata !== undefined && (metadata === null || Object(metadata) !== metadata || Array.isArray(metadata))) {
    throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] Content revision metadata must be an object." })
  }
  return { ...metadata, content }
}

function textOf(content: WorkspaceWriteInput["content"]): string | undefined {
  if (content === undefined) return
  return hasRuntimeType(content, "string") ? content : new TextDecoder().decode(content)
}

/** Create the document runtime for every collection and install validation on their Workspace paths. */
export function createContentCollections(options: ContentCollectionsOptions): ContentCollectionsRuntime {
  const workspaceName = options.workspace
  const texts = new BoundedCache<string>(32 * 1024 * 1024, text => text.length * 2)
  const revisions = new BoundedCache<Promise<OpenedRevision>>(16)
  const publishListeners: Array<(collections: string[]) => Promise<void> | void> = []
  let historyPromise: Promise<WorkspaceRetainedHistory> | undefined

  function history(): Promise<WorkspaceRetainedHistory> {
    historyPromise ??= (async () => {
      // SAFETY: Content accepts any Workspace name; the registry rejects unknown names when the facade resolves.
      const workspace = useWorkspace(workspaceName as never, { mode: "write" })
      const capabilities = await workspace.capabilities()
      if (!capabilities.retainedHistory) {
        throw contentErrorDiagnostics.CONTENT_R0007({
          message: `[vitehub] Content collections need retained history, but Workspace ${JSON.stringify(workspaceName)} has none. Use the Blob + Database Store for this Workspace.`,
        })
      }
      return workspace.history
    })()
    historyPromise.catch(() => {
      historyPromise = undefined
    })
    return historyPromise
  }

  async function openRevision(revision: WorkspaceRevision | string): Promise<OpenedRevision> {
    const id = hasRuntimeType(revision, "string") ? revision : revision.id
    return await memoize(revisions, id, async () => {
      const view = await (await history()).open(id)
      const files = new Map<string, string>()
      await Promise.all((await view.list("", { recursive: true })).map(async (entry) => {
        if (entry.type !== "file") return
        files.set(entry.path, entry.digest ?? await sha256(await view.readFile(entry.path)))
      }))
      return { revision: view.revision, view, files }
    })
  }

  async function refState(ref: ContentRef): Promise<RefState> {
    const retained = await history()
    // An empty draft mirrors the published ref until the first save.
    const head = await retained.head({ ref }) ?? (ref === "draft" ? await retained.head({ ref: "published" }) : null)
    return head ? { revision: head, opened: await openRevision(head) } : { revision: null }
  }

  async function readText(opened: OpenedRevision, path: string): Promise<string> {
    const digest = opened.files.get(path)
    if (digest === undefined) throw contentErrorDiagnostics.CONTENT_R0004({ message: `[vitehub] Content could not find ${JSON.stringify(path)}.` })
    const cached = texts.get(digest)
    if (cached !== undefined) return cached
    const text = await opened.view.readFile(path)
    texts.set(digest, text)
    return text
  }

  const updatedAtMaps = new BoundedCache<Promise<ReadonlyMap<string, string | null>>>(16)

  function isDocumentPath(path: string): boolean {
    for (const collection of collections.values()) {
      if (collection.compiled.match(path)) return true
    }
    return false
  }

  /** Paths a Content commit changed, from its `metadata.content.documents`. Undefined for other commits and seeds. */
  function contentCommitPaths(revision: WorkspaceRevision): Set<string> | undefined {
    const content: unknown = revision.metadata?.content
    const documents: unknown = content !== null && Object(content) === content ? Reflect.get(Object(content), "documents") : undefined
    if (!Array.isArray(documents)) return
    const paths = new Set<string>()
    for (const document of documents) {
      const collection = collections.get(String(Reflect.get(Object(document), "collection")))
      const id: unknown = Reflect.get(Object(document), "id")
      if (!collection || String(id) !== id) return
      try {
        paths.add(collection.pathFor(id))
      }
      catch {
        return
      }
    }
    return paths
  }

  /**
   * When each document in a revision last changed on its ref. Walks the ref backwards: Content commits name the
   * documents they changed, and any other commit is compared with its parent. A cached older revision ends the walk.
   */
  function updatedAtMap(opened: OpenedRevision): Promise<ReadonlyMap<string, string | null>> {
    return memoize(updatedAtMaps, opened.revision.id, async () => {
      const result = new Map<string, string | null>()
      const pending = new Map<string, string>()
      for (const [path, digest] of opened.files) {
        if (isDocumentPath(path)) pending.set(path, digest)
      }
      const retained = await history()
      const ref = opened.revision.ref
      let queue: WorkspaceRevision[] = [opened.revision]
      let cursor: string | undefined = opened.revision.id
      let scanned = 0
      while (pending.size && scanned < maxUpdatedAtScan) {
        if (!queue.length) {
          if (!cursor) break
          const page = await retained.list({ ref, cursor, limit: 100 })
          queue = page.revisions
          cursor = page.cursor
          if (!queue.length) break
        }
        const revision = queue.shift()!
        scanned++
        const cached = revision.id === opened.revision.id ? undefined : updatedAtMaps.get(revision.id)
        if (cached) {
          // Pending documents did not change after this revision, so they keep its answer.
          const earlier = await cached
          for (const path of pending.keys()) result.set(path, earlier.get(path) ?? null)
          pending.clear()
          break
        }
        const touched = contentCommitPaths(revision)
        if (touched) {
          for (const path of touched) {
            if (pending.delete(path)) result.set(path, revision.createdAt)
          }
          continue
        }
        const parent = revision.parentId ? await openRevision(revision.parentId) : undefined
        for (const [path, digest] of pending) {
          if (parent?.files.get(path) === digest) continue
          result.set(path, revision.createdAt)
          pending.delete(path)
        }
      }
      for (const path of pending.keys()) result.set(path, null)
      return result
    })
  }

  // Seed an empty draft from the published ref so a first save does not drop every published document.
  async function seedDraft(retained: WorkspaceRetainedHistory): Promise<void> {
    const published = await retained.head({ ref: "published" })
    if (!published) return
    const opened = await openRevision(published)
    const files = Object.fromEntries(await mapLimit([...opened.files.keys()], 8, async path => [path, await opened.view.readFile(path, { encoding: "binary" })] as const))
    try {
      await retained.commit({ ref: "draft", ifHead: null, files, message: "Start the draft from published content", metadata: { content: { action: "seed", from: published.id } } })
    }
    catch (error) {
      if (!isWorkspaceConflict(error)) throw error
    }
  }

  const collections = new Map<string, CollectionRuntime>()
  const plugin = registerWorkspacePlugin(workspaceName, {
    id: "vitehub.content",
    hooks: {
      // Every Workspace writer, including Agents, Sessions, and other history commits, goes through this check.
      "write:validate": async (input) => {
        if (input.operation !== "writeFile") return
        const path = input.path.replace(/^\/+/, "")
        for (const collection of collections.values()) {
          if (!collection.compiled.match(path)) continue
          const text = textOf(input.content)
          if (text === undefined) return
          const parsed = await collection.parseText(text)
          if (parsed.issues) throw contentInvalid(collection.name, collection.idFor(path), path, parsed.issues)
          return
        }
      },
    },
  })

  type CollectionRuntime = ReturnType<typeof createCollection>

  function createCollection(name: string, definition: DocumentsDefinition) {
    const compiled: CompiledDocumentsPath = compileDocumentsPath(definition.path)
    const fieldNames = new Set(Object.keys(definition.fields))
    const schema = fieldsJsonSchema(definition.fields)
    warnUntypedFields(name, definition.fields, schema)
    const comarkSchema: JsonSchema = comarkJsonSchema(schema)
    const parsedTexts = new BoundedCache<Promise<ParsedText>>(10_000)
    const indexes = new BoundedCache<Promise<IndexedDocument[]>>(4)
    const searchFields = (definition.search ?? [
      ...Object.keys(definition.fields).filter((field) => {
        const type = Reflect.get(Object(Reflect.get(Object(schema.properties), field)), "type")
        return type === "string" || (Array.isArray(type) && type.includes("string")) || type === undefined
      }),
      "body",
    ]).map(fieldPath)

    function fieldPath(field: string): string {
      return fieldNames.has(field) ? `data.${field}` : field
    }

    function idFor(path: string): string {
      return path.slice(compiled.base.length, path.length - compiled.extension.length)
    }

    function pathFor(id: unknown): string {
      if (String(id) !== id || !id || id.startsWith("/") || id.endsWith("/") || id.includes("\\")
        || id.split("/").some(segment => !segment || segment === "." || segment === "..")) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Content document id must be a relative path such as "hello" or "2026/hello", received ${JSON.stringify(id)}.` })
      }
      const path = `${compiled.base}${id}${compiled.extension}`
      if (!compiled.match(path)) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Content document ${JSON.stringify(id)} is outside collection ${JSON.stringify(name)} (${definition.path}).` })
      }
      return path
    }

    function entries(files: ReadonlyMap<string, string>): Map<string, CollectionEntry> {
      const result = new Map<string, CollectionEntry>()
      for (const [path, digest] of files) {
        if (compiled.match(path)) result.set(idFor(path), { path, digest })
      }
      return result
    }

    async function parseText(text: string): Promise<ParsedText> {
      const file = parseDocumentFile(text)
      if ("issues" in file) return { issues: file.issues }
      const result = await validateFields(definition.fields, file.frontmatter)
      if (result.issues) return { issues: result.issues }
      return { data: result.data, body: file.body }
    }

    async function parseEntry(opened: OpenedRevision, entry: CollectionEntry): Promise<ParsedText> {
      return await memoize(parsedTexts, entry.digest, async () => await parseText(await readText(opened, entry.path)))
    }

    function documentOf(
      id: string,
      entry: CollectionEntry,
      parsed: { data: Record<string, unknown>, body: string },
      revision: WorkspaceRevision,
      updatedAt: string | null,
    ): IndexedDocument {
      return { collection: name, id, path: entry.path, data: { ...parsed.data }, body: parsed.body, digest: entry.digest, revision: revision.id, updatedAt }
    }

    async function index(opened: OpenedRevision): Promise<IndexedDocument[]> {
      return await memoize(indexes, opened.revision.id, async () => {
        const updated = await updatedAtMap(opened)
        const documents = await mapLimit([...entries(opened.files)], 8, async ([id, entry]) => {
          const parsed = await parseEntry(opened, entry)
          if (!parsed.issues) return documentOf(id, entry, parsed, opened.revision, updated.get(entry.path) ?? null)
          // Listing skips a document that no longer validates; get() reports why.
          console.warn(contentInvalid(name, id, entry.path, parsed.issues).message)
          return undefined
        })
        return documents.filter(document => document !== undefined).sort((left, right) => left.id.localeCompare(right.id))
      })
    }

    function queryOf(options: ContentListOptions): Record<string, string | string[]> {
      const query: Record<string, string | string[]> = {}
      const filter: Record<string, unknown> = options.filter ?? {}
      for (const [field, raw] of Object.entries(filter)) {
        if (raw === undefined || raw === null) continue
        if (field === "empty") {
          query.empty = (Array.isArray(raw) ? raw : [raw]).map(value => fieldPath(String(value)))
          continue
        }
        query[fieldPath(field)] = (Array.isArray(raw) ? raw : [raw]).map(value =>
          Object.prototype.toString.call(value) === "[object Date]" ? new Date(Number(value)).toISOString() : String(value))
      }
      if (options.search !== undefined) query.search = String(options.search)
      return query
    }

    async function list(options: ContentListOptions = {}): Promise<ContentPage> {
      const state = await refState(assertRef(options.ref, "published"))
      const items = state.opened ? await index(state.opened) : []
      const digest = `${name}:${state.revision?.id ?? "empty"}`
      const listed = defineCollection({
        source: array(() => ({ digest, items }), {
          defaultLimit: listDefaultLimit,
          facets: options.facets?.map(fieldPath),
          maxLimit: listMaxLimit,
          search: searchFields,
          sort: options.sort ? { direction: options.sort.direction, field: fieldPath(options.sort.field) } : undefined,
        }),
        transform: ({ body: _body, ...summary }: IndexedDocument): ContentDocumentSummary => summary,
      })
      const page = await listed.page({ cursor: options.cursor, limit: options.limit, query: queryOf(options), signal: options.signal })
      const facets = page.facets && Object.fromEntries(Object.entries(page.facets).map(([path, values]) => [path.replace(/^data\./, ""), values]))
      const result: ContentPage = { items: page.items, nextCursor: page.nextCursor, total: page.total ?? page.items.length }
      if (facets) result.facets = facets
      return result
    }

    async function openFor(method: string, options: ContentReadOptions): Promise<OpenedRevision | undefined> {
      if (options.revision !== undefined && options.ref !== undefined) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Content ${method}() takes ref or revision, not both.` })
      }
      return options.revision !== undefined
        ? await openRevision(String(options.revision))
        : (await refState(assertRef(options.ref, "published"))).opened
    }

    async function get(id: string, options: ContentReadOptions = {}): Promise<IndexedDocument | null> {
      const path = pathFor(id)
      const opened = await openFor("get", options)
      const digest = opened?.files.get(path)
      if (!opened || digest === undefined) return null
      const entry = { path, digest }
      const parsed = await parseEntry(opened, entry)
      if (parsed.issues) throw contentInvalid(name, id, path, parsed.issues)
      return documentOf(id, entry, parsed, opened.revision, (await updatedAtMap(opened)).get(path) ?? null)
    }

    async function raw(id: string, options: ContentReadOptions = {}): Promise<ContentRawDocument | null> {
      const path = pathFor(id)
      const opened = await openFor("raw", options)
      const digest = opened?.files.get(path)
      if (!opened || digest === undefined) return null
      return { collection: name, id, path, text: await readText(opened, path), digest, revision: opened.revision.id }
    }

    async function commitDocument(
      id: string,
      path: string,
      change: { text: string, digest: string, data: Record<string, unknown>, body: string } | { delete: true },
      writeOptions: ContentWriteOptions,
      action: "save" | "remove" | "restore",
    ): Promise<IndexedDocument | undefined> {
      if (writeOptions.ifDigest !== undefined && writeOptions.ifDigest !== null && String(writeOptions.ifDigest) !== writeOptions.ifDigest) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] Content ifDigest must be a digest string or null." })
      }
      const metadata = writeMetadata(writeOptions.metadata, { action, documents: [{ collection: name, id }] })
      const message = writeOptions.message ?? `${action[0]!.toUpperCase()}${action.slice(1)} ${name}/${id}`
      const retained = await history()
      for (let attempt = 1; ; attempt++) {
        let head = await retained.head({ ref: "draft" })
        if (!head) {
          await seedDraft(retained)
          head = await retained.head({ ref: "draft" })
        }
        const opened = head ? await openRevision(head) : undefined
        const current = opened?.files.get(path) ?? null
        if (writeOptions.ifDigest !== undefined && writeOptions.ifDigest !== current) {
          throw contentConflict(`[vitehub] Content document ${JSON.stringify(`${name}/${id}`)} changed on the draft.`, {
            actual: current, collection: name, expected: writeOptions.ifDigest, id, path, ref: "draft",
          })
        }
        if ("delete" in change && current === null) throw contentNotFound(name, id)
        if (!("delete" in change) && current === change.digest && opened) {
          // Unchanged content keeps the current draft revision.
          const parsed = await parseEntry(opened, { path, digest: current })
          if (!parsed.issues) return documentOf(id, { path, digest: current }, parsed, opened.revision, (await updatedAtMap(opened)).get(path) ?? null)
        }
        try {
          const revision = await retained.commit({
            ref: "draft",
            ifHead: head?.id ?? null,
            changes: "delete" in change ? { delete: [path] } : { put: { [path]: change.text } },
            message,
            metadata,
          })
          if ("delete" in change) return
          texts.set(change.digest, change.text)
          return documentOf(id, { path, digest: change.digest }, change, revision, revision.createdAt)
        }
        catch (error) {
          // Another document moved the draft head. Retry unless this document changed, which the digest check catches.
          if (isWorkspaceConflict(error) && conflictRef(error) === "draft" && attempt < maxCommitAttempts) continue
          throw error
        }
      }
    }

    async function save(id: string, input: ContentSaveInput, writeOptions: ContentWriteOptions = {}): Promise<IndexedDocument> {
      const path = pathFor(id)
      if (input === null || Object(input) !== input) throw contentInvalid(name, id, path, [{ message: "save() requires { data, body }.", path: [] }])
      const body = input.body === undefined ? "" : input.body
      if (typeof body !== "string") throw contentInvalid(name, id, path, [{ message: "body must be a Markdown string.", path: ["body"] }])
      let frontmatter: Record<string, unknown>
      try {
        frontmatter = normalizeFrontmatter(input.data)
      }
      catch (cause) {
        throw contentInvalid(name, id, path, [{ message: cause instanceof Error ? cause.message : String(cause), path: [] }])
      }
      const validated = await validateFields(definition.fields, frontmatter)
      if (validated.issues) throw contentInvalid(name, id, path, validated.issues)
      const text = renderDocumentFile(frontmatter, body)
      // Read the stored text back so `body` matches what get() returns.
      const stored = parseDocumentFile(text)
      const storedBody = "issues" in stored ? body : stored.body
      // SAFETY: A put always returns the stored document.
      return (await commitDocument(id, path, { text, digest: await sha256(text), data: validated.data, body: storedBody }, writeOptions, "save"))!
    }

    async function remove(id: string, writeOptions: ContentWriteOptions = {}): Promise<void> {
      await commitDocument(id, pathFor(id), { delete: true }, writeOptions, "remove")
    }

    async function restore(id: string, revision: string, writeOptions: ContentWriteOptions = {}): Promise<IndexedDocument> {
      const path = pathFor(id)
      const opened = await openRevision(String(revision))
      if (!opened.files.has(path)) throw contentNotFound(name, id)
      const text = await readText(opened, path)
      const parsed = await parseText(text)
      if (parsed.issues) throw contentInvalid(name, id, path, parsed.issues)
      // SAFETY: A put always returns the stored document.
      return (await commitDocument(id, path, { text, digest: opened.files.get(path)!, data: parsed.data, body: parsed.body }, writeOptions, "restore"))!
    }

    function status(id: string): Promise<ContentDocumentStatus | null>
    function status(): Promise<ContentDocumentStatus[]>
    async function status(id?: string): Promise<ContentDocumentStatus | ContentDocumentStatus[] | null> {
      if (id !== undefined) pathFor(id)
      const [draft, published] = await Promise.all([refState("draft"), refState("published")])
      const draftEntries = draft.opened ? entries(draft.opened.files) : new Map<string, CollectionEntry>()
      const publishedEntries = published.opened ? entries(published.opened.files) : new Map<string, CollectionEntry>()
      const statusOf = (documentId: string): ContentDocumentStatus | null => {
        const draftDigest = draftEntries.get(documentId)?.digest ?? null
        const publishedDigest = publishedEntries.get(documentId)?.digest ?? null
        if (draftDigest === null && publishedDigest === null) return null
        const state: ContentDocumentState = draftDigest === null
          ? "deleted"
          : publishedDigest === null ? "draft" : draftDigest === publishedDigest ? "published" : "changed"
        return { collection: name, id: documentId, state, draft: draftDigest, published: publishedDigest }
      }
      if (id !== undefined) return statusOf(id)
      return [...new Set([...draftEntries.keys(), ...publishedEntries.keys()])].sort().map(statusOf).filter(entry => entry !== null)
    }

    // The read-only Collection contract over `published`, for defineCollectionHandler() and useCollection().
    const published = defineCollection({
      source: {
        ...array<ContentDocumentSummary, string>([], { filters: [...fieldNames, "id"], search: searchFields }),
        load: async ({ cursor, limit, query, signal }) => {
          const { empty, search, ...values } = query
          const filter: NonNullable<ContentListOptions["filter"]> = { ...values }
          if (empty) filter.empty = empty
          return await list({ cursor, limit, search, signal, filter })
        },
      },
    })

    const collection: ContentCollection = {
      name,
      path: definition.path,
      fields: Object.freeze([...fieldNames]),
      schema,
      page: published.page,
      parseQuery: published.parseQuery,
      querySchema: published.querySchema,
      list,
      get,
      raw,
      save,
      remove,
      restore,
      status,
    }

    return { name, compiled, comarkSchema, collection, entries, idFor, parseText, pathFor }
  }

  for (const [name, definition] of Object.entries(options.collections)) {
    collections.set(name, createCollection(name, definition))
  }

  function requireCollection(name: unknown): CollectionRuntime {
    const collection = String(name) === name ? collections.get(name) : undefined
    if (!collection) {
      throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] Unknown Content collection ${JSON.stringify(name)}. Define it in defineContent({ collections }).` })
    }
    return collection
  }

  interface PublishTarget {
    collection: CollectionRuntime
    id: string
    path: string
    /** The digest `expect` requires on the draft. */
    digest?: string | null
  }

  function publishInvalid(message: string): Error {
    return contentErrorDiagnostics.CONTENT_R0009({ message: `[vitehub] ${message}` })
  }

  function readExpectations(publishOptions: ContentPublishOptions): PublishTarget[] | undefined {
    const expected: unknown = publishOptions.expect
    if (expected === undefined) return
    if (publishOptions.collection !== undefined || publishOptions.ids !== undefined) {
      throw publishInvalid("publish({ expect }) names every document to publish. Do not combine it with collection or ids.")
    }
    if (!Array.isArray(expected) || !expected.length) {
      throw publishInvalid("publish({ expect }) requires a non-empty list of { collection, id, digest }.")
    }
    const seen = new Set<string>()
    return expected.map((entry: unknown) => {
      if (entry === null || Object(entry) !== entry) throw publishInvalid("Each publish({ expect }) entry must be { collection, id, digest }.")
      const digest: unknown = Reflect.get(Object(entry), "digest")
      const id: unknown = Reflect.get(Object(entry), "id")
      const collection = requireCollection(Reflect.get(Object(entry), "collection"))
      const path = collection.pathFor(id)
      // SAFETY: pathFor() accepts only nonempty string ids.
      const documentId = id as string
      if (digest !== null && (String(digest) !== digest || !digest)) {
        throw publishInvalid(`publish({ expect }) digest for ${JSON.stringify(`${collection.name}/${documentId}`)} must be a digest string, or null for a deleted document.`)
      }
      if (seen.has(path)) throw publishInvalid(`publish({ expect }) lists ${JSON.stringify(`${collection.name}/${documentId}`)} more than once.`)
      seen.add(path)
      return { collection, id: documentId, path, digest }
    })
  }

  function mismatchMessage(mismatches: ContentPublishMismatch[]): string {
    const lines = mismatches.map(({ collection, id, actual }) =>
      `- ${collection}/${id}: ${actual === null ? "deleted on the draft" : `draft is now ${actual.slice(0, 12)}`}`)
    return `[vitehub] Content changed on the draft after it was reviewed, so publish() published nothing:\n${lines.join("\n")}`
  }

  async function publish(publishOptions: ContentPublishOptions = {}): Promise<ContentPublishResult> {
    if (publishOptions === null || Object(publishOptions) !== publishOptions) throw publishInvalid("publish() options must be an object.")
    const expectations = readExpectations(publishOptions)
    if (publishOptions.ids !== undefined && publishOptions.collection === undefined) {
      throw publishInvalid("publish({ ids }) requires collection.")
    }
    if (publishOptions.ids !== undefined && (!Array.isArray(publishOptions.ids) || !publishOptions.ids.length)) {
      throw publishInvalid("publish({ ids }) requires a non-empty list of document ids.")
    }
    if (publishOptions.ifHead !== undefined && publishOptions.ifHead !== null && (String(publishOptions.ifHead) !== publishOptions.ifHead || !publishOptions.ifHead)) {
      throw publishInvalid("publish({ ifHead }) must be a revision id or null.")
    }
    const selected = publishOptions.collection === undefined ? [...collections.values()] : [requireCollection(publishOptions.collection)]
    const retained = await history()
    for (let attempt = 1; ; attempt++) {
      const [draftHead, publishedHead] = await Promise.all([retained.head({ ref: "draft" }), retained.head({ ref: "published" })])
      if (publishOptions.ifHead !== undefined && (publishedHead?.id ?? null) !== publishOptions.ifHead) {
        throw contentConflict("[vitehub] The published Content changed before publish().", {
          actual: publishedHead?.id ?? null, expected: publishOptions.ifHead, ref: "published",
        })
      }
      const published = publishedHead ? await openRevision(publishedHead) : undefined
      // An empty draft mirrors published, as status() reports it.
      const draft = draftHead ? await openRevision(draftHead) : published
      if (expectations) {
        const mismatches: ContentPublishMismatch[] = []
        for (const { collection, id, path, digest } of expectations) {
          const actual = draft?.files.get(path) ?? null
          if (actual !== digest) mismatches.push({ collection: collection.name, id, expected: digest ?? null, actual })
        }
        if (mismatches.length) throw contentConflict(mismatchMessage(mismatches), { ref: "draft", documents: mismatches.map(mismatch => ({ ...mismatch })) })
      }
      if (!draftHead || !draft) {
        if (publishOptions.ids) throw contentNotFound(selected[0]!.name, publishOptions.ids[0]!)
        return { revision: null, documents: [] }
      }
      const targets: PublishTarget[] = expectations ?? []
      if (!expectations) {
        for (const collection of selected) {
          const ids = publishOptions.ids ?? [...new Set([
            ...collection.entries(draft.files).keys(),
            ...(published ? collection.entries(published.files).keys() : []),
          ])].sort()
          for (const id of ids) {
            const path = collection.pathFor(id)
            if (!draft.files.has(path) && !published?.files.has(path)) throw contentNotFound(collection.name, id)
            targets.push({ collection, id, path })
          }
        }
      }
      const put: Record<string, Uint8Array> = {}
      const remove: string[] = []
      const documents: ContentPublishedDocument[] = []
      for (const { collection, id, path } of targets) {
        const draftDigest = draft.files.get(path)
        const publishedDigest = published?.files.get(path)
        // Unchanged documents, and an expected deletion of a document that was never published, publish nothing.
        if (draftDigest === publishedDigest) continue
        if (draftDigest === undefined) {
          remove.push(path)
          documents.push({ collection: collection.name, id, change: "delete" })
          continue
        }
        const bytes = await draft.view.readFile(path, { encoding: "binary" })
        // A file written before the validation hook was installed must not reach `published`.
        const parsed = await collection.parseText(new TextDecoder().decode(bytes))
        if (parsed.issues) throw contentInvalid(collection.name, id, path, parsed.issues)
        put[path] = bytes
        documents.push({ collection: collection.name, id, change: publishedDigest === undefined ? "add" : "update" })
      }
      if (!documents.length) return { revision: null, documents: [] }
      try {
        const revision = await retained.commit({
          ref: "published",
          ifHead: publishedHead?.id ?? null,
          ifHeads: expectations ? { draft: draftHead.id } : undefined,
          changes: { put, delete: remove },
          message: publishOptions.message ?? `Publish ${documents.length} Content document${documents.length === 1 ? "" : "s"}`,
          metadata: writeMetadata(publishOptions.metadata, {
            action: "publish",
            draft: draftHead.id,
            documents: documents.map(({ collection, id }) => ({ collection, id })),
          }),
        })
        const affected = [...new Set(documents.map(document => document.collection))]
        for (const listener of publishListeners) await listener(affected)
        return { revision, documents }
      }
      catch (error) {
        if (expectations && isWorkspaceConflict(error) && conflictRef(error) === "draft") {
          const head = await retained.head({ ref: "draft" })
          const current = head ? await openRevision(head) : published
          const mismatches: ContentPublishMismatch[] = []
          for (const { collection, id, path, digest } of expectations) {
            const actual = current?.files.get(path) ?? null
            if (actual !== digest) mismatches.push({ collection: collection.name, id, expected: digest ?? null, actual })
          }
          if (mismatches.length) throw contentConflict(mismatchMessage(mismatches), { ref: "draft", documents: mismatches.map(mismatch => ({ ...mismatch })) })
          // An unrelated document moved draft: retry with the same reviewed digests.
          if (attempt < maxCommitAttempts) continue
        }
        // Without ifHead, a concurrent publish only moves the base: recompute against the new head and check `expect` again.
        if (isWorkspaceConflict(error) && conflictRef(error) === "published" && publishOptions.ifHead === undefined && attempt < maxCommitAttempts) continue
        throw error
      }
    }
  }

  async function documentRevisions(collection: string, id: string, revisionOptions: ContentRevisionsOptions = {}): Promise<ContentRevisionsResult> {
    const runtime = requireCollection(collection)
    runtime.pathFor(id)
    const ref = assertRef(revisionOptions.ref, "draft")
    const limit = revisionOptions.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] Content revisions() limit must be an integer from 1 to 100." })
    }
    const retained = await history()
    const found: WorkspaceRevision[] = []
    let cursor = revisionOptions.cursor
    let scanned = 0
    do {
      const page = await retained.list({ ref, limit: 100, cursor })
      for (const revision of page.revisions) {
        scanned++
        if (!revisionTouches(revision, runtime.name, id)) continue
        found.push(revision)
        if (found.length === limit) return { revisions: found, cursor: revision.id }
      }
      cursor = page.cursor
    } while (cursor && scanned < maxRevisionScan)
    return cursor ? { revisions: found, cursor } : { revisions: found }
  }

  function comarkSource(name: string, ref: ContentRef = "published"): ContentHistorySource {
    const collection = requireCollection(name)
    let current: { revision: string | null, opened?: OpenedRevision, files: Map<string, string> } | undefined
    async function load() {
      const state = await refState(ref)
      const files = new Map<string, string>()
      for (const [path, digest] of state.opened?.files ?? []) {
        if (collection.compiled.match(path)) files.set(path, digest)
      }
      current = { revision: state.revision?.id ?? null, opened: state.opened, files }
      return current
    }
    async function read(key: string): Promise<string> {
      const state = current ?? await load()
      if (!state.opened || !state.files.has(key)) {
        throw contentErrorDiagnostics.CONTENT_R0004({ message: `[vitehub] Content collection ${JSON.stringify(name)} has no ${JSON.stringify(key)} on ${ref}.` })
      }
      return await readText(state.opened, key)
    }
    return {
      schema: collection.comarkSchema,
      keys: async () => [...(await load()).files.keys()],
      getItem: read,
      getItemRaw: read,
      withRef: next => comarkSource(name, assertRef(next, "published")),
      get loadedRevision() {
        return current?.revision
      },
    }
  }

  return {
    collections: new Map([...collections].map(([name, runtime]) => [name, runtime.collection])),
    collection: name => requireCollection(name).collection,
    publish,
    revisions: documentRevisions,
    comarkSource: name => comarkSource(name),
    onPublish: listener => {
      publishListeners.push(listener)
    },
    publishedHead: async () => (await (await history()).head({ ref: "published" }))?.id ?? null,
    dispose: plugin,
  }
}
